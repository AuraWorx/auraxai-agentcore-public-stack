"""Admin models for the feedback eval-sampling surface (spec §11 PR-4).
Content-free: ids, codes, scores, counts. No conversation text, and never
the judge's explanation (the content-policy walk covers this module)."""

from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


class EvaluatorScore(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    value: float
    rating: Optional[str] = None
    n: int = 1
    tokens: int = 0


class FeedbackVerdict(BaseModel):
    """The judged result stored on a thumb row."""
    model_config = ConfigDict(populate_by_name=True)

    reason: str = "none"
    evaluators: List[str] = Field(default_factory=list)
    scores: Dict[str, EvaluatorScore] = Field(default_factory=dict)
    tool_failure_corroborated: Optional[bool] = Field(None, alias="toolFailureCorroborated")


class DownThumbQueueItem(BaseModel):
    """One recent down-thumb as the sampler's queue sees it."""
    model_config = ConfigDict(populate_by_name=True)

    session_id: str = Field(..., alias="sessionId")
    message_id: int = Field(..., alias="messageId")
    reason: Optional[str] = None
    updated_at: str = Field("", alias="updatedAt")
    retry_message_id: Optional[int] = Field(None, alias="retryMessageId")
    evaluated_at: Optional[str] = Field(None, alias="evaluatedAt")
    evaluation: Optional[FeedbackVerdict] = None


class DownThumbQueueResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    items: List[DownThumbQueueItem]
    pending: int = Field(0, description="Items in this page not yet judged")
    sampling_enabled: bool = Field(False, alias="samplingEnabled")


class SamplingRunResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    accepted: bool
    limit: int
    note: str
