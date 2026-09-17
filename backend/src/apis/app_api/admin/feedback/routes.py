"""Admin feedback routes — the eval-sampling queue (spec §11 PR-4).

    GET  /admin/feedback/evaluations         recent down-thumbs + any verdict
    POST /admin/feedback/evaluations/run     judge up to `limit` of them, offline

Scope: ``admin.costs`` — the judge spends tokens and the verdicts sit beside
the cost rows. The run is a background task (the SDK waits on span
ingestion; minutes, not milliseconds) and 404s while
``FEEDBACK_EVAL_SAMPLING_ENABLED`` is off, per the flag's docstring.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query

from apis.shared.auth import User, require_admin_scope
from apis.shared.feature_flags import feedback_eval_sampling_enabled
from apis.shared.storage.dynamodb_storage import DynamoDBStorage

from .models import DownThumbQueueItem, DownThumbQueueResponse, SamplingRunResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/feedback", tags=["admin-feedback"])
require_feedback_admin = require_admin_scope("admin.costs")


def get_storage() -> DynamoDBStorage:
    return DynamoDBStorage()


def get_judge():
    """The AgentCore Evaluations adapter. A dependency so tests inject a fake."""
    from apis.shared.feedback_eval.sampler import AgentCoreJudge

    return AgentCoreJudge()


@router.get("/evaluations", response_model=DownThumbQueueResponse, response_model_by_alias=True)
async def list_down_thumb_queue(
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(require_feedback_admin),
    storage: DynamoDBStorage = Depends(get_storage),
):
    """Recent down-thumbs across the fleet, newest first, with the verdict
    where one exists. Content-free by projection."""
    try:
        rows = await storage.get_recent_down_thumbs(limit=limit)
    except Exception:
        logger.error("Error listing the down-thumb queue", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to list feedback queue")
    items = []
    for row in rows:
        try:
            items.append(DownThumbQueueItem(**row))
        except Exception:  # noqa: BLE001 - a malformed row is skipped, not fatal
            continue
    return DownThumbQueueResponse(
        items=items,
        pending=sum(1 for i in items if not i.evaluated_at),
        sampling_enabled=feedback_eval_sampling_enabled(),
    )


@router.post("/evaluations/run", response_model=SamplingRunResponse, status_code=202, response_model_by_alias=True)
async def run_eval_sampling(
    background: BackgroundTasks,
    limit: int = Query(10, ge=1, le=50),
    current_user: User = Depends(require_feedback_admin),
    storage: DynamoDBStorage = Depends(get_storage),
    judge=Depends(get_judge),
):
    """Judge up to ``limit`` recent, not-yet-judged down-thumbs in the
    background. 202 immediately; results appear on the queue list and the
    session profiles as they land."""
    if not feedback_eval_sampling_enabled():
        raise HTTPException(status_code=404, detail="Not found")

    def cost_row_lookup(session_id: str, message_id: int) -> Optional[Dict[str, Any]]:
        # Sync lookup for tool-failure corroboration: the call's C# row.
        try:
            from boto3.dynamodb.conditions import Key

            response = storage.sessions_metadata_table.query(
                IndexName="SessionLookupIndex",
                KeyConditionExpression=Key("GSI_PK").eq(f"SESSION#{session_id}") & Key("GSI_SK").begins_with("C#"),
            )
            for item in response.get("Items", []):
                try:
                    if int(item.get("messageId")) == message_id:
                        return storage._convert_decimal_to_float(item)
                except (TypeError, ValueError):
                    continue
        except Exception:  # noqa: BLE001 - corroboration is best-effort
            return None
        return None

    async def task() -> None:
        from apis.shared.feedback_eval.sampler import run_sampling_batch

        try:
            await run_sampling_batch(
                storage.sessions_metadata_table, judge, limit=limit, cost_row_lookup=cost_row_lookup,
            )
        except Exception:  # noqa: BLE001 - background; nothing to return to
            logger.error("eval sampling batch failed", exc_info=True)

    background.add_task(task)
    logger.info("Admin queued an eval sampling batch (limit=%d)", limit)
    return SamplingRunResponse(
        accepted=True,
        limit=limit,
        note="Judging runs in the background; the SDK waits for span ingestion, so allow a few minutes.",
    )
