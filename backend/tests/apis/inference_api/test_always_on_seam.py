"""The always-on union at the invocation seam (PR-2, §7 D4).

`_apply_admin_always_on_tools` is where the pinned set meets the turn. The
load-bearing behaviour here is D4: the exemption is "the Agent binds its own
toolset", NOT "the turn ran an Agent". Getting that backwards in either
direction is a bug — one overrides an author's explicit scoping, the other
turns always-on into an opt-out button.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from apis.inference_api.chat import routes

USER = SimpleNamespace(user_id="u1", roles=["staff"])


def _resolver(ids):
    return AsyncMock(return_value=list(ids))


class TestAgentBindingExemption:
    @pytest.mark.asyncio
    async def test_an_agent_that_binds_tools_is_left_alone(self):
        """The Agent owns its toolset, like modelConfig owns the model."""
        with patch.object(
            routes, "resolve_always_on_tool_ids", _resolver(["pinned"])
        ) as resolver:
            bound = ["agent_tool_a", "agent_tool_b"]
            result = await routes._apply_admin_always_on_tools(
                bound, USER, agent_bound_tools=True
            )
        assert result is bound
        # Not merely unchanged — never even resolved. A bound turn should not
        # pay for a set it cannot use.
        resolver.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_an_agent_with_no_tool_bindings_still_gets_the_pinned_set(self):
        """§7 D4 — the anti-bypass case, and the COMMON one.

        `_resolve_tools` returns None (so `agent_bound_tools` is False) for an
        Agent with no tool bindings, and template-derived Agents ship with
        empty `bindings` by design. Exempting them would let anyone shed a
        pinned tool with a trivial unbound Agent.
        """
        with patch.object(routes, "resolve_always_on_tool_ids", _resolver(["pinned"])):
            result = await routes._apply_admin_always_on_tools(
                ["picker_tool"], USER, agent_bound_tools=False
            )
        assert result == ["picker_tool", "pinned"]

    @pytest.mark.asyncio
    async def test_the_default_chat_turn_gets_the_pinned_set(self):
        with patch.object(routes, "resolve_always_on_tool_ids", _resolver(["pinned"])):
            result = await routes._apply_admin_always_on_tools(["picker_tool"], USER)
        assert result == ["picker_tool", "pinned"]


class TestUnionSemantics:
    @pytest.mark.asyncio
    async def test_a_pinned_tool_the_user_already_enabled_is_not_duplicated(self):
        with patch.object(routes, "resolve_always_on_tool_ids", _resolver(["search_web"])):
            result = await routes._apply_admin_always_on_tools(
                ["search_web", "browse_web"], USER
            )
        assert result == ["search_web", "browse_web"]

    @pytest.mark.asyncio
    async def test_an_all_off_picker_receives_exactly_the_pinned_set(self):
        """§5 — a deliberate behaviour change, gated behind an admin flagging.

        `ToolFilter` returns NO tools for an empty list, so a user who turned
        everything off used to get a tool-less agent. They now get the pinned
        set, which is the point.
        """
        with patch.object(routes, "resolve_always_on_tool_ids", _resolver(["pinned"])):
            assert await routes._apply_admin_always_on_tools([], USER) == ["pinned"]

    @pytest.mark.asyncio
    async def test_pinned_ids_append_after_the_request_in_resolver_order(self):
        """The appended segment reaches `toolConfig`; its order must be fixed."""
        with patch.object(routes, "resolve_always_on_tool_ids", _resolver(["a", "b", "c"])):
            result = await routes._apply_admin_always_on_tools(["z"], USER)
        assert result == ["z", "a", "b", "c"]


class TestDeployIsANoOp:
    """§10 — with nothing pinned, the caller's own object comes back."""

    @pytest.mark.asyncio
    async def test_none_stays_none(self):
        with patch.object(routes, "resolve_always_on_tool_ids", _resolver([])):
            assert await routes._apply_admin_always_on_tools(None, USER) is None

    @pytest.mark.asyncio
    async def test_the_list_object_is_returned_by_identity(self):
        original = ["search_web"]
        with patch.object(routes, "resolve_always_on_tool_ids", _resolver([])):
            result = await routes._apply_admin_always_on_tools(original, USER)
        # Identity, not equality: an implementation that rebuilt an equal list
        # would pass `==` and still change the agent-cache slot downstream.
        assert result is original
