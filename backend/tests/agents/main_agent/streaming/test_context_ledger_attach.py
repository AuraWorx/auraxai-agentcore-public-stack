"""The stream coordinator persists the context ledger and the prefix split on
the call's cost row, as extra fields next to `toolCalls`."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agents.main_agent.session.hooks.context_attribution import _SPLIT_ATTR
from agents.main_agent.streaming.stream_coordinator import StreamCoordinator


def _coordinator() -> StreamCoordinator:
    return object.__new__(StreamCoordinator)


def _usage_metadata(cache_read=80_000):
    # The prompt the provider billed has to be able to CONTAIN the split under
    # test: `prefixTokens` is reconciled against
    # inputTokens + cacheRead + cacheWrite before it is stored.
    return {
        "usage": {
            "inputTokens": 100,
            "outputTokens": 20,
            "totalTokens": 120,
            "cacheReadInputTokens": cache_read,
        }
    }


def _wrapper(strands_agent):
    # A plain namespace, not a MagicMock: the coordinator reads
    # `model_config.model_id` into a pydantic model and a mock is not a str.
    return SimpleNamespace(
        agent=strands_agent,
        model_config=SimpleNamespace(model_id="claude-haiku-4-5", model_name="Claude Haiku 4.5"),
    )


def _wrapper_with_split(system=12_000, tools=48_000):
    strands_agent = SimpleNamespace()
    setattr(strands_agent, _SPLIT_ATTR, {"systemTokens": system, "toolTokens": tools})
    return _wrapper(strands_agent)


async def _store(monkeypatch, cache_read=80_000, **kwargs):
    monkeypatch.delenv("COST_DIAGNOSTICS_ENABLED", raising=False)
    store = AsyncMock()
    with patch("apis.shared.sessions.metadata.store_message_metadata", store), \
         patch("agents.main_agent.streaming.stream_coordinator.get_prefix_fingerprint", return_value=None):
        await _coordinator()._store_message_metadata(
            session_id="s1", user_id="u1", message_id=3,
            accumulated_metadata=_usage_metadata(cache_read),
            stream_start_time=0.0, stream_end_time=1.0, first_token_time=0.5,
            call_index=0, **kwargs,
        )
    store.assert_awaited_once()
    return store.await_args.kwargs["message_metadata"]


@pytest.mark.asyncio
async def test_ledger_and_prefix_split_are_attached(monkeypatch):
    stored = await _store(
        monkeypatch,
        agent=_wrapper_with_split(),
        context_ledger={
            "windowRemovedMessages": 6,
            "compactionEvents": [{"kind": "applied", "summaryTokens": 1200}],
        },
    )
    extra = stored.model_extra
    assert extra["windowRemovedMessages"] == 6
    assert extra["compactionEvents"] == [{"kind": "applied", "summaryTokens": 1200}]
    assert extra["prefixTokens"] == {"system": 12_000, "tools": 48_000}
    dumped = stored.model_dump(by_alias=True)
    assert dumped["prefixTokens"]["tools"] == 48_000


@pytest.mark.asyncio
async def test_split_larger_than_the_billed_prompt_is_not_stored(monkeypatch):
    """`toolTokens` is a residual between two estimators, so it can come back
    larger than the whole prompt it claims to be part of (prod session
    7f5f207f: tools=223,782 against a 55,783-token prompt). Storing that makes
    the admin page assert something arithmetically impossible, so the row
    carries no `prefixTokens` at all and reads "not tracked"."""
    stored = await _store(
        monkeypatch,
        cache_read=1_000,          # 1,100-token prompt vs a 60,000-token split
        agent=_wrapper_with_split(),
        context_ledger={"windowRemovedMessages": 6},
    )
    extra = stored.model_extra or {}
    assert "prefixTokens" not in extra
    # The rest of the ledger is unaffected — only the split is in doubt.
    assert extra["windowRemovedMessages"] == 6


@pytest.mark.asyncio
async def test_absent_ledger_and_split_leave_no_fields(monkeypatch):
    stored = await _store(monkeypatch, agent=_wrapper(SimpleNamespace()), context_ledger=None)
    for key in ("windowRemovedMessages", "compactionEvents", "prefixTokens"):
        assert key not in (stored.model_extra or {})


@pytest.mark.asyncio
async def test_kill_switch_drops_the_prefix_split_too(monkeypatch):
    monkeypatch.setenv("COST_DIAGNOSTICS_ENABLED", "false")
    store = AsyncMock()
    with patch("apis.shared.sessions.metadata.store_message_metadata", store), \
         patch("agents.main_agent.streaming.stream_coordinator.get_prefix_fingerprint", return_value=None):
        await _coordinator()._store_message_metadata(
            session_id="s1", user_id="u1", message_id=3,
            accumulated_metadata=_usage_metadata(),
            stream_start_time=0.0, stream_end_time=1.0, first_token_time=0.5,
            agent=_wrapper_with_split(), call_index=0, context_ledger=None,
        )
    stored = store.await_args.kwargs["message_metadata"]
    assert "prefixTokens" not in (stored.model_extra or {})


@pytest.mark.asyncio
async def test_the_argument_is_optional_for_the_interrupt_path(monkeypatch):
    stored = await _store(monkeypatch, agent=None)
    assert "windowRemovedMessages" not in (stored.model_extra or {})
