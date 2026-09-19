"""The deferred, narrated agent build (docs/specs/agent-state-feedback.md PR-3).

Measured on dev: a cold agent-cache miss spends 1478ms inside `get_agent`,
and because FastAPI flushes response headers when the handler returns its
`StreamingResponse`, every millisecond of that is dead air. PR-3 defers the
build into the stream generator so the response opens first and the wait can
be narrated.

What is worth pinning is the part that is easy to get wrong:

1. The frame is emitted **only when the build is actually slow**. A warm build
   is 0-38ms, and announcing "Getting ready" for 38ms would flash a phase the
   user cannot read — landing, worse, *after* the generic "Thinking" the client
   already shows, which reads as going backwards.
2. A build that RAISES inside the generator cannot reach the handler's `except`
   arms any more, so it must surface as a conversational error rather than a
   silent hang.
3. The lease is released either way.

Driven through the real coordinator-shaped pieces where practical; the build
itself is a stub, because what matters here is timing and failure, not what
`get_agent` returns.
"""

import asyncio
import json
from typing import Any, AsyncGenerator, List, Optional

import pytest

from apis.inference_api.chat.routes import _PREPARING_NOTICE_SECONDS


def _frames_of(kind: str, frames: List[str]) -> List[dict]:
    prefix = f"event: {kind}\ndata: "
    return [
        json.loads(f[len(prefix) :].strip())
        for f in frames
        if f.startswith(prefix)
    ]


class _Harness:
    """A faithful copy of the generator's build-and-narrate preamble.

    The real `_guarded_stream` is a closure over ~40 locals inside a
    1700-line handler; reproducing its *decision* here keeps the test on the
    behaviour under change instead of on FastAPI wiring. The shape below is
    kept in step with `routes.py` by `test_route_still_matches_this_shape`.
    """

    def __init__(self, build_seconds: float, fails: bool = False) -> None:
        self.build_seconds = build_seconds
        self.fails = fails
        self.released = False
        self.built = False

    async def _build(self) -> Any:
        await asyncio.sleep(self.build_seconds)
        if self.fails:
            raise RuntimeError("tool registry exploded")
        self.built = True
        return object()

    async def stream(self) -> AsyncGenerator[str, None]:
        agent: Optional[Any] = None
        try:
            build = asyncio.ensure_future(self._build())
            finished, _ = await asyncio.wait(
                {build}, timeout=_PREPARING_NOTICE_SECONDS
            )
            if not finished:
                yield (
                    "event: agent_status\ndata: "
                    + json.dumps(
                        {
                            "type": "agent_status",
                            "sessionId": "sess-1",
                            "phase": "preparing",
                        }
                    )
                    + "\n\n"
                )
            try:
                agent = await build
            except Exception:
                yield 'event: stream_error\ndata: {"code": "AGENT_ERROR"}\n\n'
                yield "event: done\ndata: {}\n\n"
                return
            assert agent is not None
            yield 'event: message_start\ndata: {"role": "assistant"}\n\n'
            yield "event: done\ndata: {}\n\n"
        finally:
            self.released = True


class TestWhenTheFrameIsEmitted:
    @pytest.mark.asyncio
    async def test_a_slow_build_is_narrated(self):
        harness = _Harness(build_seconds=_PREPARING_NOTICE_SECONDS + 0.2)

        frames = [f async for f in harness.stream()]

        statuses = _frames_of("agent_status", frames)
        assert [s["phase"] for s in statuses] == ["preparing"]
        assert harness.built

    @pytest.mark.asyncio
    async def test_a_fast_build_is_not(self):
        """The warm path. 38ms of "Getting ready" is a flicker, not a status."""
        harness = _Harness(build_seconds=0.01)

        frames = [f async for f in harness.stream()]

        assert _frames_of("agent_status", frames) == []
        assert harness.built

    @pytest.mark.asyncio
    async def test_the_frame_precedes_the_turn_it_explains(self):
        harness = _Harness(build_seconds=_PREPARING_NOTICE_SECONDS + 0.2)

        frames = [f async for f in harness.stream()]

        preparing = next(
            i for i, f in enumerate(frames) if "preparing" in f
        )
        message_start = next(
            i for i, f in enumerate(frames) if f.startswith("event: message_start")
        )
        assert preparing < message_start

    @pytest.mark.asyncio
    async def test_the_frame_carries_no_cycle(self):
        """`preparing` precedes the event loop, so there is no cycle to number.

        The SPA validator accepts it on that basis; sending a fabricated cycle
        would make the two disagree about what the phase means.
        """
        harness = _Harness(build_seconds=_PREPARING_NOTICE_SECONDS + 0.2)

        frames = [f async for f in harness.stream()]

        assert "cycle" not in _frames_of("agent_status", frames)[0]


class TestFailure:
    @pytest.mark.asyncio
    async def test_a_failed_build_surfaces_as_a_conversational_error(self):
        """The handler has already returned, so its `except` arms cannot see
        this. Without the in-generator catch it is a silent hung stream."""
        harness = _Harness(build_seconds=0.01, fails=True)

        frames = [f async for f in harness.stream()]

        assert any(f.startswith("event: stream_error") for f in frames)
        assert any(f.startswith("event: done") for f in frames)
        assert not any(f.startswith("event: message_start") for f in frames)

    @pytest.mark.asyncio
    async def test_a_failed_build_still_releases_the_lease(self):
        harness = _Harness(build_seconds=0.01, fails=True)

        [f async for f in harness.stream()]

        assert harness.released

    @pytest.mark.asyncio
    async def test_a_slow_failing_build_narrates_then_errors(self):
        harness = _Harness(build_seconds=_PREPARING_NOTICE_SECONDS + 0.2, fails=True)

        frames = [f async for f in harness.stream()]

        assert [s["phase"] for s in _frames_of("agent_status", frames)] == [
            "preparing"
        ]
        assert any(f.startswith("event: stream_error") for f in frames)
        assert harness.released


class TestRouteContract:
    def test_route_still_matches_this_shape(self):
        """Guards the harness above against the route drifting away from it.

        A copy of a decision is only useful while it is still a copy.
        """
        from pathlib import Path

        import apis.inference_api.chat.routes as routes_module

        source = Path(routes_module.__file__).read_text()

        # The build is raced against the threshold, not awaited outright.
        assert "asyncio.wait(" in source
        assert "_PREPARING_NOTICE_SECONDS" in source
        # The frame is emitted only in the not-finished arm.
        assert "if not finished:" in source
        assert '"phase": "preparing"' in source
        # A build failure is caught inside the generator.
        assert "Deferred agent build failed" in source

    def test_the_threshold_sits_between_the_measured_warm_and_cold_builds(self):
        """0-38ms warm, 1478ms cold (dev, 2026-09-19). A threshold inside that
        gap classifies both correctly with room to spare."""
        assert 0.038 < _PREPARING_NOTICE_SECONDS < 1.478
