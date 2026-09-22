"""Platform cost sync — pulls the AWS bill into the admin cost dashboard.

Why this exists
---------------
The dashboard's own ledger measures Bedrock model spend per user and per
session, and measures it well: against prod's September 1-21 bill it came
within 0.50% of Cost Explorer's model SKUs ($1,076.03 vs $1,081.44). What it
cannot see is everything that is not a token. On prod that was **38.8% of the
bill** -- $685.96 of $1,767.41 -- with `Amazon Bedrock AgentCore` alone at
$201.54/month, the second-largest line item in the account and invisible to
every screen we had. "Avg Cost/User" was therefore reporting $0.60 against a
true all-in cost of $0.98, understating unit economics by 1.64x.

Why a scheduled sync and not a live query
-----------------------------------------
Cost Explorer bills **$0.01 per request**. A page that queried it on load
would cost ~$10/month per thousand loads for the privilege of displaying
costs, and would put an admin screen's latency at the mercy of a billing API.
So this runs once a day, writes the answer into the existing
`system-cost-rollup` table, and the read path never touches Cost Explorer.
One invocation is one CE call per period synced: ~$0.30/year.

Attribution, and why it is a service allowlist rather than tags
---------------------------------------------------------------
Every resource `applyStandardTags` creates carries `Project` / `Environment` /
`Version`, which *should* make this exact. It does not, yet: no cost
allocation tag is activated in either account, so grouping by `Project`
returns a single `Project$` bucket holding the entire bill. Activation is an
org-management-account action (a Control Tower linked account gets
`AccessDeniedException` listing them) and is **not retroactive**.

Meanwhile the accounts are shared -- `bsu-prod-backend` / `bsu-dev-backend`
run an Aurora Serverless cluster we do not provision and must not bill to our
users. So attribution is by service, in three buckets:

  inference  -- the per-token model SKUs ("... (Amazon Bedrock Edition)").
                Reported for RECONCILIATION ONLY. The dashboard's per-user
                numbers keep using our own ledger, which is finer-grained
                (per user, per session, per call) and independently accurate.
                Divergence here means our pricing tables have drifted, which
                CLAUDE.md names as a live risk -- so this is a regression
                test on pricing, not a data source.
  excluded   -- another team's resources, plus account-level charges no single
                application causes: Support (a percentage of spend), the
                Control Tower governance baseline (Config, CloudTrail,
                Security Hub, GuardDuty), and Cost Explorer itself, whose
                inclusion would make the cost of measuring cost compound.
  platform   -- everything else. This is the number the dashboard adds.

The split is deliberately coarse and deliberately visible: `excluded` is
persisted and surfaced rather than silently dropped, because an operator
needs to see what was left out to trust what was kept. Swap the allowlist for
`GROUP BY TAG Project` once the tag is active; the row shape does not change.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Tuple

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Cost Explorer has no regional endpoints; us-east-1 is the only one.
CE_REGION = "us-east-1"

# A model SKU bills as its own SERVICE, e.g. "Claude Sonnet 5 (Amazon Bedrock
# Edition)" or "OpenAI GPT-5.6 Terra (Amazon Bedrock Edition)". Matching the
# suffix catches every provider without a per-model list to maintain.
#
# Note "Amazon Bedrock" (no suffix) is NOT inference -- it is the non-token
# side of Bedrock (guardrails, knowledge bases) and belongs in `platform`.
INFERENCE_SERVICE_SUFFIX = "(Amazon Bedrock Edition)"

# Services billed to these accounts that our users did not cause. Excluded
# from the platform total, but persisted under `category="excluded"` so the UI
# can show what was held out and why.
#
# `PLATFORM_COST_EXCLUDED_SERVICES` OVERRIDES this list; it does not extend
# it. An unset or empty variable must therefore leave the default intact --
# the failure mode we are avoiding is the one from the browser URL blocklist,
# where an unset env var silently emptied a list that was load-bearing and
# nothing looked wrong until the thing it guarded went through.
DEFAULT_EXCLUDED_SERVICES = (
    # A different application in the same accounts. We provision no RDS.
    "Amazon Relational Database Service",
    # Percentage-of-spend, account-level. Attributing it to this platform
    # would also make the platform total move when another team spends.
    "AWS Business Support+",
    "AWS Business Support",
    "AWS Support (Business)",
    "AWS Support (Developer)",
    "AWS Support (Enterprise)",
    # Control Tower / org governance baseline. Present whether or not this
    # platform exists, and in dev it is $157/month of the bill.
    "AWS Config",
    "AWS CloudTrail",
    "AWS Security Hub",
    "Amazon GuardDuty",
    "AWS Audit Manager",
    # The cost of measuring cost. Small, but including it means every sync
    # raises the number the next sync reports.
    "AWS Cost Explorer",
    # Human console sessions, not platform workload.
    "AWS CloudShell",
)


def _excluded_services() -> frozenset[str]:
    """Resolve the exclusion list, treating unset/empty as 'use the default'."""
    raw = (os.environ.get("PLATFORM_COST_EXCLUDED_SERVICES") or "").strip()
    if not raw:
        return frozenset(DEFAULT_EXCLUDED_SERVICES)
    names = [part.strip() for part in raw.split(",")]
    resolved = frozenset(name for name in names if name)
    # A variable that is present but parses to nothing is a misconfiguration,
    # not an instruction to bill another team's database to our users.
    return resolved or frozenset(DEFAULT_EXCLUDED_SERVICES)


def classify_service(service_name: str, excluded: Iterable[str]) -> str:
    """Bucket one Cost Explorer SERVICE value: inference | excluded | platform."""
    if service_name in set(excluded):
        return "excluded"
    if service_name.endswith(INFERENCE_SERVICE_SUFFIX):
        return "inference"
    return "platform"


def _month_bounds(period: str, today: date) -> Tuple[str, str, bool]:
    """Return (start, end, partial) for a YYYY-MM period.

    Cost Explorer's `End` is EXCLUSIVE. For a month still in progress the end
    is tomorrow rather than the first of next month, so a sync run today does
    not silently claim to cover days that have not happened -- `partial` is
    persisted so the UI can label a month-to-date figure as one.
    """
    year, month = (int(part) for part in period.split("-"))
    start = date(year, month, 1)
    next_month = date(year + (month == 12), (month % 12) + 1, 1)
    if next_month <= today:
        return start.isoformat(), next_month.isoformat(), False
    # CE rejects an end date in the future; tomorrow is the latest it accepts
    # and is what gives a complete picture of everything billed so far.
    return start.isoformat(), (today + timedelta(days=1)).isoformat(), True


def _fetch_service_costs(ce_client, start: str, end: str) -> List[Tuple[str, float]]:
    """One CE call ($0.01) -> [(service_name, unblended_cost_usd)].

    Paginated defensively: ~30-40 services fit one page today, but a page-two
    truncation would show up as a quietly low platform total rather than an
    error, which is the worst way for a cost figure to be wrong.
    """
    rows: List[Tuple[str, float]] = []
    next_token: str | None = None
    calls = 0

    while True:
        kwargs: Dict[str, Any] = {
            "TimePeriod": {"Start": start, "End": end},
            "Granularity": "MONTHLY",
            "Metrics": ["UnblendedCost"],
            "GroupBy": [{"Type": "DIMENSION", "Key": "SERVICE"}],
        }
        if next_token:
            kwargs["NextPageToken"] = next_token

        response = ce_client.get_cost_and_usage(**kwargs)
        calls += 1

        for result in response.get("ResultsByTime", []):
            for group in result.get("Groups", []):
                keys = group.get("Keys") or []
                if not keys:
                    continue
                amount = group.get("Metrics", {}).get("UnblendedCost", {}).get("Amount")
                try:
                    cost = float(amount)
                except (TypeError, ValueError):
                    continue
                rows.append((keys[0], cost))

        next_token = response.get("NextPageToken")
        if not next_token:
            break
        if calls >= 10:
            logger.warning(
                "Stopped paginating Cost Explorer after %d pages; totals may be low",
                calls,
            )
            break

    # MONTHLY granularity over a single month yields one ResultsByTime entry,
    # but collapse duplicates anyway so a multi-entry response cannot
    # double-count a service.
    merged: Dict[str, float] = {}
    for name, cost in rows:
        merged[name] = merged.get(name, 0.0) + cost
    return sorted(merged.items(), key=lambda item: item[1], reverse=True)


def _dec(value: float) -> Decimal:
    """DynamoDB has no float type; 6dp is well under a cent."""
    return Decimal(str(round(value, 6)))


def sync_period(
    period: str,
    ce_client,
    table,
    *,
    today: date,
    account_id: str,
    min_service_cost: float,
) -> Dict[str, Any]:
    """Sync one YYYY-MM period. Idempotent: every write is a full overwrite."""
    start, end, partial = _month_bounds(period, today)
    excluded = _excluded_services()
    services = _fetch_service_costs(ce_client, start, end)

    totals = {"inference": 0.0, "platform": 0.0, "excluded": 0.0}
    rows: List[Dict[str, Any]] = []

    for name, cost in services:
        category = classify_service(name, excluded)
        totals[category] += cost
        # Sub-cent services are counted in the totals but not persisted as
        # their own row -- a 30-row breakdown where 12 rows read $0.00 is
        # harder to read, not more complete.
        if cost >= min_service_cost:
            rows.append({"serviceName": name, "cost": cost, "category": category})

    synced_at = datetime.now(timezone.utc).isoformat()
    grand_total = totals["inference"] + totals["platform"] + totals["excluded"]

    with table.batch_writer(overwrite_by_pkeys=["PK", "SK"]) as batch:
        for row in rows:
            batch.put_item(
                Item={
                    "PK": f"PLATFORM#SERVICE#{period}",
                    "SK": row["serviceName"],
                    "serviceName": row["serviceName"],
                    "cost": _dec(row["cost"]),
                    "category": row["category"],
                    "period": period,
                    "syncedAt": synced_at,
                }
            )

    # Written AFTER the service rows, so a crash mid-sync leaves the previous
    # (consistent) summary in place rather than a new summary whose breakdown
    # is half-written.
    table.put_item(
        Item={
            "PK": "PLATFORM#MONTHLY",
            "SK": period,
            "period": period,
            "inferenceCost": _dec(totals["inference"]),
            "platformCost": _dec(totals["platform"]),
            "excludedCost": _dec(totals["excluded"]),
            "totalCost": _dec(grand_total),
            "serviceCount": len(rows),
            "coverageStart": start,
            "coverageEnd": end,
            "partialMonth": partial,
            "accountId": account_id,
            "currency": "USD",
            "source": "cost-explorer",
            "syncedAt": synced_at,
        }
    )

    logger.info(
        json.dumps(
            {
                "event": "platform_cost_synced",
                "period": period,
                "platformCost": round(totals["platform"], 2),
                "inferenceCost": round(totals["inference"], 2),
                "excludedCost": round(totals["excluded"], 2),
                "services": len(rows),
                "partialMonth": partial,
            }
        )
    )

    return {
        "period": period,
        "platformCost": round(totals["platform"], 2),
        "inferenceCost": round(totals["inference"], 2),
        "excludedCost": round(totals["excluded"], 2),
        "serviceCount": len(rows),
        "partialMonth": partial,
    }


def _periods_to_sync(event: Dict[str, Any], today: date) -> List[str]:
    """Which months to sync.

    Default is this month plus last: a month's final charges keep settling for
    days after it ends, so a sync that only ever touched the current month
    would freeze every December at whatever it looked like on the 1st.
    An explicit `{"periods": [...]}` in the event drives a manual backfill.
    """
    requested = event.get("periods") if isinstance(event, dict) else None
    if isinstance(requested, list) and requested:
        return [str(p) for p in requested][:12]

    current = today.strftime("%Y-%m")
    first_of_month = today.replace(day=1)
    previous = (first_of_month - timedelta(days=1)).strftime("%Y-%m")
    return [current, previous]


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:  # noqa: ANN401
    """Daily EventBridge tick. Also invocable by hand for a backfill."""
    event = event if isinstance(event, dict) else {}

    if (os.environ.get("PLATFORM_COST_SYNC_ENABLED") or "true").lower() == "false":
        logger.info("Platform cost sync disabled by env flag; no-op")
        return {"status": "disabled", "synced": []}

    table_name = os.environ.get("DYNAMODB_SYSTEM_ROLLUP_TABLE_NAME")
    if not table_name:
        logger.error("DYNAMODB_SYSTEM_ROLLUP_TABLE_NAME unset; cannot sync")
        return {"status": "misconfigured", "synced": []}

    try:
        min_service_cost = float(os.environ.get("PLATFORM_COST_MIN_SERVICE_USD") or 0.01)
    except ValueError:
        min_service_cost = 0.01

    ce_client = boto3.client("ce", region_name=CE_REGION)
    table = boto3.resource("dynamodb").Table(table_name)
    account_id = os.environ.get("AWS_ACCOUNT_ID", "")
    today = datetime.now(timezone.utc).date()

    synced: List[Dict[str, Any]] = []
    failures: List[Dict[str, str]] = []

    for period in _periods_to_sync(event, today):
        try:
            synced.append(
                sync_period(
                    period,
                    ce_client,
                    table,
                    today=today,
                    account_id=account_id,
                    min_service_cost=min_service_cost,
                )
            )
        except Exception as exc:  # noqa: BLE001
            # One bad period must not cost the others. An AccessDenied here is
            # the expected shape when ce:GetCostAndUsage has not been granted
            # or an SCP denies it, and the dashboard degrades to
            # inference-only rather than erroring.
            logger.exception("Platform cost sync failed for %s", period)
            failures.append({"period": period, "error": type(exc).__name__})

    return {
        "status": "ok" if not failures else "partial",
        "synced": synced,
        "failures": failures,
    }
