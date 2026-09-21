"""Resolving the admin-pinned ("always on") tool set for one caller.

An admin can flag a tool `alwaysOn` so it is pinned into every turn's
effective toolset and the user cannot turn it off in the picker. This module
answers the only question the chat path asks: *which pinned ids may this
caller actually have?*

**Enables, never grants.** A pinned tool the caller's roles do not carry is
dropped here. The same predicate the picker and Agent bindings answer to
(`AppRoleService.filter_requested_tools`, role grant ∪ public tools) decides
it, so the three surfaces cannot drift apart.

**No I/O per candidate.** The pinned set comes from the catalog snapshot that
already rides the `freshness` TTL read, and the grant set is resolved once
inside `filter_requested_tools` (itself served from the in-process
`AppRoleCache`). One resolve plus set membership — not one lookup per pinned
tool, which is the shape that would spend the turn-latency budget this
feature was designed to leave alone. See docs/specs/admin-always-on-tools.md
§4.

**Never raises.** A catalog or RBAC failure logs and yields no pinned ids: a
governance default must not be able to break a chat turn.
"""

import logging
from typing import List

from apis.shared.auth.models import User
from apis.shared.tools.freshness import get_always_on_tool_ids

logger = logging.getLogger(__name__)


async def resolve_always_on_tool_ids(user: User) -> List[str]:
    """The pinned tool ids ``user`` is entitled to, in a fixed sorted order.

    Order matters and is not incidental. `ToolFilter` iterates
    ``enabled_tools`` in order and `collect_tool_name_filters` keeps catalog
    ids in first-seen order, so the list order reaches the Bedrock
    ``toolConfig`` — the cacheable prefix. Sorting at the source is what keeps
    the appended segment byte-stable between turns; a `set` anywhere between
    here and the request list would reintroduce hash-order non-determinism and
    silently re-write the prefix at the cache-write premium.

    Ids are a mix of bare catalog ids and scoped ``base::name`` ids, carried
    **verbatim** — collapsing a scoped id to its base would restore the whole
    MCP server.
    """
    from apis.shared.feature_flags import admin_always_on_tools_enabled

    if not admin_always_on_tools_enabled():
        return []

    try:
        pinned = await get_always_on_tool_ids()
    except Exception:  # noqa: BLE001 - a catalog blip must not fail the turn
        logger.warning("Failed to read the always-on tool snapshot", exc_info=True)
        return []

    if not pinned:
        return []

    try:
        from apis.shared.rbac.service import get_app_role_service

        # `filter_requested_tools` resolves the grant set ONCE, handles the
        # `"*"` wildcard, admits a scoped id when its base server is granted,
        # and preserves the order it is given — so sorting the input here is
        # what fixes the output order.
        return await get_app_role_service().filter_requested_tools(
            user, sorted(pinned)
        )
    except Exception:  # noqa: BLE001 - an RBAC lookup failure must not fail the turn
        logger.warning(
            "RBAC check for the always-on tool set failed; pinning nothing",
            exc_info=True,
        )
        return []
