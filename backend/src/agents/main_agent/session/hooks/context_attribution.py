"""Hook that computes a per-turn context-token attribution breakdown.

Splits the authoritative projected input-token count (Bedrock-native via
``CountTokensBedrockModel``) into ``system`` / ``tools`` / ``messages``
partitions and stashes the result on the agent. The stream coordinator reads
it via :func:`get_context_breakdown` and attaches it to the turn's final
``metadata`` SSE event as ``contextBreakdown`` — answering "what is filling the
context window?" without an aggregate-only guess.

Decomposition (convention validated live against Bedrock CountTokens):

- ``systemTokens`` = ``count(system only)``
- ``toolTokens``   = ``full - count(system + messages, no tools)`` — the tool
  schemas **plus** the tool-use scaffolding Bedrock injects only when tools and
  a conversation coexist (~400 tokens). Folded into Tools by design: it is the
  true marginal cost of having tools enabled. An empty-messages baseline would
  miss the scaffolding and mis-attribute it to messages.
- ``messageTokens`` = ``full - systemTokens - toolTokens`` (residual; grows with
  the conversation, scaffolding-free). Partitions sum to ``full`` by
  construction.

``systemTokens`` / ``toolTokens`` are stable across a session (the tool
overhead is constant as the conversation grows — verified), so they are
computed once per agent at cold start (two extra CountTokens calls) and cached;
every turn afterward is pure arithmetic against the free, authoritative
``projected_input_tokens``.

**Why the split is not computed while an attachment is in context.**
``toolTokens`` is a *residual* between two independently sourced numbers —
``full`` (Strands' projection for the upcoming request) and ``no_tools`` (our own
CountTokens call) — so any disagreement between them about how a content block
is counted lands wholly in it. Bedrock understands a PDF page as an image *and*
a text layer; when the two sources do not agree on that, the document's entire
weight is attributed to tools. Measured on dev 2026-09-16 (session
``61de2256``): a call reported ``toolTokens`` of **106,756** where the session's
real tools prefix was **12,516** — a difference of 94,240 against a document
measured at ~94,485, i.e. the whole document. The split is therefore skipped on
any turn whose context carries inline document or image bytes, and taken on a
later clean turn instead. An absent ``prefixTokens`` reads "not tracked" (the
ledger's convention); a wrong one silently corrupts every share computed from
it.

Best-effort: any failure is swallowed so context attribution can never break a
model call. For non-Bedrock models ``count_tokens`` falls back to a heuristic,
so the numbers are approximate there.
"""

import logging
from typing import Any, Dict, Optional

from strands.hooks import BeforeModelCallEvent, HookProvider, HookRegistry

logger = logging.getLogger(__name__)

# Stashed on the per-session Strands agent instance.
_SPLIT_ATTR = "_context_attribution_split"          # cached stable {systemTokens, toolTokens}
_BREAKDOWN_ATTR = "_context_attribution_breakdown"  # latest per-turn breakdown dict


def _has_inline_attachment(messages: Any) -> bool:
    """Whether any message carries inline ``document`` / ``image`` bytes.

    The condition under which ``toolTokens`` cannot be trusted — see the module
    docstring. Cheap: a walk over content blocks, no decoding."""
    if not isinstance(messages, list):
        return False
    for message in messages:
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            for key in ("document", "image"):
                payload = block.get(key)
                if isinstance(payload, dict):
                    source = payload.get("source")
                    if isinstance(source, dict) and isinstance(
                        source.get("bytes"), (bytes, bytearray)
                    ):
                        return True
    return False


def get_context_breakdown(agent: Any) -> Optional[dict]:
    """Return the latest context breakdown stashed on ``agent``, or ``None``.

    Used by the stream coordinator to enrich the final ``metadata`` SSE event.
    """
    return getattr(agent, _BREAKDOWN_ATTR, None)


def get_prefix_token_split(agent: Any) -> Optional[Dict[str, int]]:
    """The stable ``{"system": n, "tools": n}`` split for this agent, or ``None``.

    Persisted on each call's cost row (as ``prefixTokens``) so the static
    prefix a session carries — and which part of it is tool schemas — is a
    stored fact rather than a scan-and-guess. Same numbers the SSE breakdown
    reports; this just reads the cached split without re-counting.
    """
    split = getattr(agent, _SPLIT_ATTR, None)
    if not isinstance(split, dict):
        return None
    try:
        return {
            "system": int(split.get("systemTokens") or 0),
            "tools": int(split.get("toolTokens") or 0),
        }
    except (TypeError, ValueError):
        return None


class ContextAttributionHook(HookProvider):
    """Compute the system / tools / messages token breakdown each turn."""

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        registry.add_callback(BeforeModelCallEvent, self._on_before_model_call)

    async def _on_before_model_call(self, event: BeforeModelCallEvent) -> None:
        try:
            await self._compute(event)
        except Exception as e:  # noqa: BLE001 - attribution must never break a turn
            logger.debug("Context attribution skipped: %s", e)

    async def _compute(self, event: BeforeModelCallEvent) -> None:
        agent = event.agent
        model = agent.model
        system_prompt = getattr(agent, "system_prompt", None)
        system_prompt_content = getattr(agent, "_system_prompt_content", None)
        full = event.projected_input_tokens

        split = getattr(agent, _SPLIT_ATTR, None)
        if split is None and _has_inline_attachment(agent.messages):
            # Untrustworthy residual (see module docstring) — leave the split
            # uncomputed and try again on a turn without inline bytes.
            logger.debug("Context attribution deferred: inline attachment in context")
            return
        if split is None:
            system_tokens = await model.count_tokens(
                messages=[],
                system_prompt=system_prompt,
                system_prompt_content=system_prompt_content,
            )
            # system + the current conversation, WITHOUT tools — so the
            # difference from `full` captures tool schemas + the tool-use
            # scaffolding (present only when tools and messages coexist).
            no_tools = await model.count_tokens(
                messages=agent.messages,
                system_prompt=system_prompt,
                system_prompt_content=system_prompt_content,
            )
            if full is None:
                # projected estimate unavailable — count the full request once
                # so cold start can still establish the split.
                tool_specs = agent.tool_registry.get_all_tool_specs()
                full = await model.count_tokens(
                    messages=agent.messages,
                    tool_specs=tool_specs,
                    system_prompt=system_prompt,
                    system_prompt_content=system_prompt_content,
                )
            split = {
                "systemTokens": system_tokens,
                "toolTokens": max(0, full - no_tools),
            }
            setattr(agent, _SPLIT_ATTR, split)

        if full is None:
            # No authoritative total this turn — can't place the messages
            # partition. Leave the previous breakdown (if any) untouched.
            return

        message_tokens = max(0, full - split["systemTokens"] - split["toolTokens"])
        breakdown = {
            "total": full,
            "partitions": [
                {"key": "system", "label": "System prompt", "tokens": split["systemTokens"]},
                {"key": "tools", "label": "Tools", "tokens": split["toolTokens"]},
                {"key": "messages", "label": "Messages", "tokens": message_tokens},
            ],
        }
        setattr(agent, _BREAKDOWN_ATTR, breakdown)
