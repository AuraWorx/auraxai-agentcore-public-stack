# Admin "always-on" tools

**Status:** Proposed — not implemented
**Scope:** Any turn whose toolset comes from the user's picker. An Agent that
binds its own tools is exempt; an Agent that binds none is not (see §7, D4)
**Refs:** `_apply_attachment_tool_autoenable` (`inference_api/chat/routes.py`) is
the pattern this follows; `docs/specs/turn-latency-preamble.md` is the latency
budget it must not spend.
**Compatibility:** deploying this with no tool flagged must be a no-op — §10.

## Problem

An admin can make a tool *available* (`isPublic`, or a role's `grantedTools`)
and can make it *on by default* (`enabledByDefault`). There is no way to make
one **stay** on.

`enabledByDefault` is an initial condition, not a policy: the moment a user
toggles the tool off in the picker, their `UserToolPreference` row overrides it
forever. For a tool that exists because the organization decided everyone
should have it — a knowledge-base search that is the whole point of the
deployment, a records lookup the answers are wrong without — "on until someone
turns it off" is not the property the admin thought they were buying.

Three concrete shapes this takes:

1. A tool is rolled out with `enabledByDefault: true`; users who had already
   saved *any* preference set never receive it, because their stored map is
   consulted first.
2. A user turns a tool off while debugging something, forgets, and every
   subsequent answer silently loses a capability the org depends on.
3. An admin wants "everyone gets the campus KB" and has no way to express it
   short of removing every other tool.

## The thing that decides the design

**`enabled_tools` is client-supplied and, on the default chat path, never
re-validated.**

[`chat-request.service.ts:420`](../../frontend/ai.client/src/app/session/services/chat/chat-request.service.ts)
sends whatever the SPA computed from its own picker state;
[`base_agent.py:498`](../../backend/src/agents/main_agent/base_agent.py) hands
that list straight to `ToolFilter`. The only `can_access_tool` re-check on the
inference path lives in the **Agent-binding** resolver
(`agent_binding_resolver.py:255`) — an ordinary turn has none.

So a locked toggle in the picker is cosmetic. If the requirement is "users
can't remove it", enforcement has to be a **server-side union in the invocation
path**. Everything else in this spec follows from that.

A corollary worth stating plainly before anyone sells this feature: the
enforcement boundary is the SPA → inference-api request, and that boundary is
currently untrusted with respect to tool *selection*. Always-on is strong
enough for "make sure every user actually has the KB tool" and is **not**
sufficient for "users must not be able to avoid the compliance logger" — a
crafted request can still omit an id. Closing that gap means intersecting
`enabled_tools` with the caller's grant set on the default path too, which is a
separate (and larger) change. §9 lists it as a follow-up.

## 1. The seam already exists

CSV auto-enable (`ATTACHMENT_TOOL_AUTOENABLE_ENABLED`) built exactly this
mechanism for a different reason, and it got the shape right:

- **`_with_auto_enabled_tools(enabled_tools, auto_ids)`** (`routes.py:911`) —
  unions ids in, **returning the same object when there is nothing to add**, so
  a caller that passed `None` still passes `None` and every consumer (cache
  key, builders, guidance, `ToolFilter`) sees one value.
- **`_apply_attachment_tool_autoenable(...)`** (`routes.py:962`) — "the single
  seam every `get_agent` caller on the invocation path goes through, so the main
  turn and the MCP App dispatch paths compute the same effective list — and
  therefore the same agent-cache slot."
- **Enables, never grants** — each candidate id passes `can_access_tool`, the
  same predicate the picker and Agent bindings answer to.
- **Fixed order** — `sorted(SPREADSHEET_TOOL_IDS)`, appended.
- **Applied before the cache key**, to the *effective* list (`routes.py:3055`).
- **Behind a default-on flag with a kill switch.**

Always-on is `_apply_admin_always_on_tools` in the same place, with one
deliberate divergence (§7, D4).

## 2. Data model

### 2.1 Catalog row

`ToolDefinition` gains one field, alongside `enabled_by_default`:

```python
always_on: bool = Field(
    default=False,
    description=(
        "If true, this tool is unioned into every turn's effective toolset for "
        "users whose roles grant it, and the user cannot turn it off. Enables, "
        "never grants."
    ),
)
```

Persisted as `alwaysOn` on the DynamoDB item; absent on existing rows reads
back `False`, so no backfill. Backward compatibility is a stated requirement
of this feature rather than a hoped-for property — see §10, which also records
the cleanup this encoding defers.

### 2.2 Why a boolean and not a three-state enum

`enabledByDefault: false` + `alwaysOn: true` is incoherent, and a plain second
boolean lets an admin save it. The clean fix is an enum
(`user_choice` / `default_on` / `always_on`), and that is the right shape in the
abstract — but `enabled_by_default` is persisted on every catalog row in dev and
prod, is in `ToolCreateRequest`/`ToolUpdateRequest`/`UserToolAccess`, in four
SPA models, and in the seeder. A migration across all of that to eliminate one
invalid combination is not a good trade.

**Instead:** keep both booleans, and make the invalid combination
unrepresentable *through the API* with a `model_validator` on `ToolDefinition`
that forces `enabled_by_default = True` whenever `always_on` is True. The admin
form renders the pair as a single three-way segmented control, so the invalid
state is not reachable from the UI either. The normalization runs on read as
well as write, so a hand-written DynamoDB item cannot produce it.

### 2.3 Per-tool always-on inside an MCP server

`MCPToolEntry` already carries a per-tool flag (`needs_approval`), so the
precedent exists:

```python
always_on: bool = Field(default=False)   # serialized as `alwaysOn`
```

This matters for cost (§6): marking a 30-tool MCP server always-on puts 30 tool
specs in every user's `toolConfig` forever, where the admin usually wanted one.
Resolution emits the **scoped** id `base::name` for such an entry.

`collect_tool_name_filters` makes this safe in both directions (verified at
`scoped_ids.py:58`):

- server already whole-enabled (`b` present) + injected `b::x` → a bare id
  **wins over** scoped ids for the same base, so the server stays whole. No
  accidental narrowing.
- server partially enabled (`b::y`) + injected `b::x` → `{x, y}`. Correct
  widening.
- server absent entirely + injected `b::x` → `{"b": {"x"}}`. Exactly the
  intended always-on behavior.

⚠️ Scoped ids must be carried **verbatim** into `enabled_tools`. Collapsing one
to its base restores the whole server — the bug scoping exists to prevent, and
invisible from outside because the turn still works.

## 3. Resolution

A new module-level helper in `apis/shared/tools/`:

```
always_on_tool_ids(grant_set) -> list[str]
```

returning, in a **fixed sorted order**:

- every `tool_id` whose catalog row has `always_on`, plus
- every `f"{tool_id}::{entry.name}"` for an `MCPToolEntry` with `always_on`,

filtered to ids whose **base** id the caller's grant set admits.

Then, mirroring the CSV path:

```python
async def _apply_admin_always_on_tools(
    enabled_tools: list | None,
    current_user: User,
    ...
) -> list | None
```

which resolves the ids and hands them to the existing
`_with_auto_enabled_tools`. Never raises: an RBAC or catalog failure logs and
returns the list unchanged, because a governance feature must not be able to
break a turn.

## 4. Latency: the TTFT budget

This is the part to get right. The warm pre-stream window is **128–189ms** after
four PRs of work, and `tools` at **98–102ms** is already the largest warm stage.
A governance check that costs a DynamoDB round trip per always-on tool would
hand back a meaningful slice of that.

**Design rule: always-on resolution adds no new I/O to the critical path.**
It is a set intersection over data two existing caches already hold.

### 4.1 The catalog set is free

`freshness._get_snapshot` already performs **one** `repo.list_tools()` per 10s
TTL window per process and derives **two** frozensets from it — `all_tool_ids`
and `public_tool_ids` — explicitly so that "one read fills the all-ids and
public-ids slots together — half the DynamoDB traffic of two independent caches,
and the two sets can never disagree about the catalog they were derived from."

Add a **third slot** to the same function:

```python
_always_on_tool_ids_cache: List[Optional[Tuple[FrozenSet[str], float]]] = [None]

async def get_always_on_tool_ids() -> FrozenSet[str]: ...
```

filled in the same pass from the same already-parsed `tools` list. The marginal
cost is one generator expression over a list that is already in memory:

- **zero** extra DynamoDB round trips
- **zero** extra `ToolDefinition.from_dynamo_item` parses (the expensive part on
  throttled container CPU)
- `invalidate(tool_id)` already clears every snapshot, so an admin write is
  visible in-process on the next turn and elsewhere within one TTL window.

### 4.2 The grant set is already resolved and cached

`can_access_tool` → `_tool_grant_set` → `resolve_user_permissions`, which is
served from `AppRoleCache` (in-process, 5-minute TTL, keyed on user **and** a
roles fingerprint) ∪ `get_public_tool_ids()` (the same 10s snapshot as above).
`preamble.quota` runs before the `tools` stage and already resolves the caller's
permissions, so by the time always-on resolves, the entry is warm. After that it
is pure set membership.

Resolve the grant set **once** and intersect, rather than `await
can_access_tool(...)` in a loop as the CSV path does. Each of those awaits is a
cache hit so the loop is not slow, but the single-resolve form makes the "no I/O
per candidate" property structural instead of incidental.

### 4.3 The cost this *does* add, stated honestly

1. **One snapshot read newly lands on the plain-turn path.** Today a turn with
   no spreadsheet and no Agent binding never calls `get_public_tool_ids()`, so
   nothing forces the snapshot. Always-on becomes its first caller. That is one
   `list_tools()` per 10s window *per process*, amortized across every
   concurrent turn in the container, and `list_tools()` is itself backed by
   `config_cache.TOOL_CATALOG` (60s) at the item level — so the DynamoDB
   `EntityTypeIndex` Query fires at most once a minute. For comparison, the turn
   path *already* pays `get_freshness_hash`, which issues up to one `get_tool`
   GetItem per enabled tool per 10s window.
2. **Always-on ids widen `get_freshness_hash`.** They are in `enabled_tools` by
   the time `get_agent` runs, so they contribute to the freshness digest —
   bounded by the number of always-on tools, TTL-cached, and gathered
   concurrently.
3. **Cold container, first turn:** one extra `list_tools()` if quota's
   permission resolve has not already warmed the snapshot. Bounded, once.

### 4.4 How this goes wrong

The obvious implementation is to reuse `ToolCatalogService.get_user_accessible_tools`
and filter for `alwaysOn`. **Do not.** That method does role hydration *and* a
`get_user_preferences` GetItem — an app-api-shaped call, sized for a page load,
landing on every chat turn. Equally, do not resolve via `repo.get_tool(id)` per
always-on id; that is the shape that reintroduces N reads.

### 4.5 Measuring it

Do **not** ship a permanent `prelude.mark("tools.always_on")`. Marks derive
metric names automatically, so each new one quietly creates a CloudWatch stream,
and a step designed to be I/O-free does not deserve a permanent one.

Instead, validate with the recipe in `turn-latency-preamble.md`: log group from
SSM `/dev-boisestateai-v2/inference-api/runtime-id`, `filter-log-events
--filter-pattern turn_prelude`, and compare the `tools` stage distribution
before and after the flag flip.

⚠️ A CloudWatch window spanning a deploy mixes two populations — min is new
code, avg is meaningless. Compare like-for-like windows either side.

⚠️ And do not anchor on a laptop measurement. The last time this was done, a
~1.5ms local number was ~47ms on the throttled container — a 30x miss that
produced the right fix for the wrong stated reason.

**Acceptance gate:** the `tools` stage p50 must not regress measurably on dev
with the flag on and at least one always-on tool configured. If it does, the
resolution is doing I/O it was designed not to do.

## 5. Prompt-cache impact

Per the prompt-cache contract, anything reaching `toolConfig` must be
deterministically ordered and append-only between turns.

- **Order.** `_hash_tools` sorts before hashing, so the *cache key* is
  order-insensitive — but `ToolFilter.filter_tools` iterates `enabled_tool_ids`
  in request order, and `collect_tool_name_filters` preserves first-seen order,
  so the **actual `toolConfig` order follows the list**. Always-on ids are
  therefore appended in a fixed sorted order, after the request's ids, exactly
  as `sorted(SPREADSHEET_TOOL_IDS)` is today. A `set` must not appear anywhere
  between resolution and the list.
- **Within a session, the union is constant** — it depends only on the catalog
  and the user's roles, neither of which changes mid-conversation under normal
  operation. So it does not flip the cache key turn to turn.
- **Flipping the flag on a live tool costs one prefix re-write per live
  session.** `freshness_hash` changes when the tool's `updated_at` bumps, the
  cached agent misses, and the rebuilt `toolConfig` differs. This is correct
  behaviour and it is not free: at 1.25× the model's base input rate on the
  cache write, across every open conversation. **Flip always-on off-peak**, and
  prefer doing it as part of a planned rollout rather than ad hoc from the admin
  page at 2pm.
- **Empty-list semantics change.** `ToolFilter` returns *no tools* for a `None`
  or empty list. A user who has turned everything off currently gets a
  tool-less agent; with always-on they get exactly the always-on set. That is
  the intent, and it is a behaviour change worth naming in the release notes.

## 6. Cost: this is a permanent line item

An always-on tool's spec sits in `toolConfig` for **every granted user, every
turn, for the life of every session**. That is precisely the question CLAUDE.md
says to answer before merging anything on the model call path.

- One small local tool is noise.
- A whole MCP server marked always-on is a fleet-wide bill, multiplied by every
  user and every session, paid at the cache-write premium on first write and
  carried in the read on every turn after.

Requirements:

- The admin form shows the **token size of the tool's spec** next to the
  always-on control, and for an MCP server, the count of tools it would pin.
- Marking an MCP *server* always-on requires an explicit confirm naming the
  tool count; the per-entry flag (§2.3) is the recommended path and the form
  should say so.
- The tool list page gains an "Always on" chip so the pinned set is auditable at
  a glance rather than by opening 31 tool forms.

**Status after PR-1.** The tool count, the blocking confirmation and the
"prefer per-tool over whole-server" steer all shipped, as did the list chip.
The **token-size readout did not** — deliberately, rather than by oversight.

A tool's serialized schema does not exist anywhere app-api can reach it. It is
produced at `BaseAgent._build_filtered_tools()` on the inference path, where
Strands serializes the registry into the Bedrock `toolConfig`; the catalog row
holds configuration, not a spec, and `ToolCensusHook` records call counts, not
sizes. Putting a number on the admin form therefore means one of:

1. measure once per tool at census or build time and persist it on the catalog
   row, so admin reads a stored figure; or
2. a small admin endpoint that builds the spec for one tool on demand.

(1) is the better shape — it is the same "measure on the path that already has
the data, read it cheaply elsewhere" move as `toolTokens` — and it is a PR of
its own. A fabricated or chars/4-estimated number would be worse than the
plain-language cost statement that shipped instead, because an admin would
budget against it.

## 7. Decisions

**D1 — Always-on enables, never grants.** An always-on tool a user's roles do
not grant is not force-enabled. This is the same half-write trap as
`allowedAppRoles`: the resource-side flag is not a grant. The admin form must
say so explicitly when the tool has no granting role — and must **not** lean on
the existing "0 roles" badge to detect it, which is known to be blind to
`TOOL_GRANT#*` rows.

**D2 — Enforcement is server-side; the SPA lock is presentation.** PR order
(§8) puts enforcement first so the UI never claims a lock the backend does not
hold.

**D3 — Show a locked toggle, don't hide the tool.** The SPA already has the
vocabulary: `agentLocked` in `tool.service.ts:137` renders exactly this for
Agent-bound turns. A tool that silently cannot be turned off reads as a bug; a
disabled toggle saying "required by your organization" reads as policy.
`UserToolAccess` gains `alwaysOn: bool`, and `isEnabled` is forced `true` for
those rows.

**D4 — The exemption is "the Agent binds its own toolset", NOT "the Agent is
user-created".** This distinction is the whole decision, and getting it wrong in
either direction is a bug.

An Agent's `tool_ids` **replace** the request's `enabled_tools` — "an Agent that
binds tools owns its toolset, like `modelConfig` owns the model". Unioning
always-on into such a turn would override the author's explicit intent and break
that contract. So `_apply_admin_always_on_tools` is skipped when
`agent_tools_override is not None`.

But `_resolve_tools` returns `None` — not an empty `ResolvedTools` — when an
Agent carries **no `tool` bindings at all** (`agent_binding_resolver.py:241`:
`if not tool_bindings: return None`). Such a turn falls straight through to the
request's `enabled_tools`, i.e. the user's own picker. **Always-on applies
there, and must.**

Two reasons:

1. That Agent is expressing no intent about tools. It is a custom system prompt
   over the default toolset, and always-on is precisely the floor under that
   toolset.
2. Otherwise always-on becomes opt-out-by-construction. A user who wants to shed
   a pinned tool creates a trivial Agent with a custom prompt and zero tool
   bindings, and the governance property evaporates. A policy with a one-click
   bypass is not a policy.

So the honest one-line summary is: *always-on does not apply to an Agent that
defines its own toolset; it does apply to an Agent that leaves the toolset to
the user.*

**The governing tenet: an Agent is a blank canvas.** Authors are expected to
bind only the tools relevant to that Agent's task, and a bound toolset is a
deliberate statement about scope. An Agent with *no* tool bindings has not made
that statement yet — it is an unfinished canvas, not a claim that the org's
pinned tools should fall away. Reading it as the latter is what would turn
always-on into an opt-out button.

⚠️ **This is the common starting shape, not an edge case.** The seeded agent
templates ship with **empty `bindings`** on purpose — "no organization-specific
tool refs, so a fork with a different tool catalog shows no dropped-tool
notices" (`apis/shared/agent_templates/seed.py`). Every Agent created from a
template therefore starts with zero tool bindings and inherits the picker. The
population that receives always-on via this path is large, and it is the
population the tenet above says *should* receive it — but see the rollout note
in PR-4. Note that the dataclass docstring for `ResolvedTools` contemplates a
meaningful empty `tool_ids` ("the Agent deliberately runs with *no* tools"), but
`_resolve_tools` cannot currently produce one — a non-empty binding list always
yields at least one ref. **If that ever changes, empty must be treated as
"binds its own toolset" (skip the union), or "no tools" silently becomes "some
tools".** Cover it with a test now, not when it regresses.

This is a **deliberate divergence from the CSV precedent**, which applies to the
effective list and therefore does reach Agent-bound turns. The difference:
CSV auto-enable serves the *user's* governing intent (they attached the file);
always-on serves the *admin's*, and the Agent author is also exercising admin
intent. Revisit if Agents grow an explicit "inherit org tools" binding — that
binding is the clean way to let an author opt back in.

**D5 — Scheduled runs and voice: in scope, and both come for free.** A
scheduled run reaches the model through `run_agent_headless`
(`apis/shared/harness`), which invokes the AgentCore Runtime over HTTP — so the
union is applied by inference-api's own `/invocations` handler, not by the
worker Lambda. Nothing in `backend/src/lambdas/scheduled_runs_worker/` changes,
and `apis/shared/tools` correctly stays out of that image's import closure.
Voice has its own `get_agent` call site (`voice_routes.py:374`) inside
inference-api and must be wired explicitly — it is the one place the union
could be forgotten by omission.

**D6 — `save_user_preferences` rejects a `false` for an always-on tool.** Not
silently ignores: return the normalized preference map so the SPA cannot drift
into showing an off state the backend will override.

**D7 — Default-on flag with a kill switch**, per house style:
`ADMIN_ALWAYS_ON_TOOLS_ENABLED`; unset or empty resolves to enabled, only the
literal `"false"` disables. While off, the catalog field is still stored and
still rendered in admin, but no union is applied and the SPA does not lock.

## 8. PR breakdown

**PR-1 — Catalog field, no enforcement.**
`ToolDefinition.always_on` + `MCPToolEntry.always_on`, the normalizing
validator, `ToolCreateRequest`/`ToolUpdateRequest`, admin routes, admin form
three-way control + token-size readout + no-granting-role warning, list-page
chip. Ships as inert data.

Carries the test that asserts §10's no-op property: with no tool marked
`alwaysOn`, the effective `enabled_tools` is the *same object* the caller
passed (identity, not equality — `_with_auto_enabled_tools` guarantees it), and
a catalog row without the attribute round-trips to `always_on=False`.

**PR-2 — Enforcement.**
`freshness.get_always_on_tool_ids` third slot, `always_on_tool_ids(grant_set)`,
`_apply_admin_always_on_tools` at the `_apply_attachment_tool_autoenable` seam
(skipping Agent-bound turns), wired into every `get_agent` call site on the
invocation path (main turn, MCP App dispatch, resume, scheduled runs, voice),
behind `ADMIN_ALWAYS_ON_TOOLS_ENABLED`. Latency validated per §4.5 before merge.

**PR-3 — SPA.**
`UserToolAccess.always_on` on `GET /tools`, `save_user_preferences` guard (D6),
locked toggle reusing the `agentLocked` presentation, "required by your
organization" copy.

**PR-4 — Flip and validate on dev.**
Mark one small local tool always-on for a role, confirm: the union appears in
the effective list; a user who toggles it off still gets it; a user whose role
lacks the grant does *not*; the `tools` stage does not regress; `cacheStatus`
on the session's `C#` rows shows `hit` on turn 2 (a `partial_miss` here means
the union is not stable between turns).

Two cases that must be exercised explicitly, because they are the D4 boundary:

- an Agent **with** tool bindings → the union is absent, the bound set is exact;
- an Agent **without** tool bindings (the template-derived default shape) → the
  union is present.

⚠️ **Rollout note.** Because template-derived Agents carry empty `bindings`,
flipping the flag changes the effective toolset of every such Agent at once —
each one pays a `toolConfig` rewrite on its next turn (§5), and its answers may
change. This is intended behaviour, but it is a fleet-wide behaviour change on a
single toggle, so: flip off-peak, start with one small tool, and say so in the
release notes rather than letting authors discover it.

On Lambda images: a new module under `apis/shared/tools/` does **not** need a
`Dockerfile.scheduled-runs` change, because that image does not carry
`apis/shared/tools` at all (D5). The general rule still applies if PR-2 grows
the closure elsewhere — a path needs both a `COPY` in the Dockerfile **and** a
`SOURCE_DIRS`/`MANIFESTS` entry in `scripts/build/build-one.sh`, or it builds
once and then ships stale code under an unchanged content-hash tag.
`test_lambda_image_copies_its_full_import_closure`
(`backend/tests/supply_chain/test_lambda_image_imports.py:189`) catches it.

## 9. Follow-ups, explicitly out of scope

- **Close the enforcement boundary.** Intersect `enabled_tools` with the
  caller's grant set on the default chat path, as the Agent-binding path already
  does. That is what would make always-on a security control rather than a
  product default. Sized separately; it changes behaviour for every turn.
- **Per-role always-on.** Pinning a tool for `faculty` but not `student` needs
  the flag on the role grant, not the catalog row. Real demand, meaningfully
  more surface — wait for the ask.
- **Agent Designer: nudge authors to bind a toolset, and to keep it tight.**
  Today the Designer does nothing to move an author off the empty canvas, so a
  template-derived Agent can ship unbound indefinitely — and under D4 it then
  carries the picker's whole toolset on every turn. Two halves, both cheap:

  1. *Nudge to bind.* A non-blocking prompt on the Agent form when `bindings`
     carries no `tool` entry, on the same footing as the existing dropped-tool
     notices. Not a validation error — an unbound Agent is legitimate (D4), just
     rarely what the author meant.
  2. *Nudge to keep it tight.* Guidance next to the tool picker in the Designer,
     with a live count and, ideally, the same token readout §6 specifies for the
     admin form.

  **Why this is a cost item, not a tidiness one.** Every bound tool's schema is
  serialized into the Bedrock `toolConfig` on **every turn** of every
  conversation with that Agent — `toolTokens` is a measured partition
  (`session/hooks/context_attribution.py`) and it is *stable across a session*:
  it does not amortize, it recurs. A real dev session measured a tools prefix of
  **12,516 tokens** carried on every single turn, plus ~400 tokens of the
  tool-use scaffolding Bedrock injects once tools and a conversation coexist. An
  author who binds twenty tools "just in case" for a task that uses three is
  paying for seventeen schemas on every turn, forever, on the cache-write
  premium the first time and the read every turn after.

  This is the same conclusion `docs/specs/tool-search-token-bloat-strategy.md`
  reaches from the other end — its Tier 0 is "**Curate first** — assistant/role-
  scoped `enabled_tools` profiles", ahead of any search machinery. The Designer
  is where curation is cheapest, because it happens once at authoring time
  instead of on every turn at runtime.

  Draft microcopy for the Designer's tool picker (wording to be reviewed, the
  substance is the point):

  > **Bind only the tools this agent actually needs.** Every tool you add is
  > sent to the model on every turn of every conversation with this agent — not
  > just the turns that use it. A focused toolset is cheaper and it also makes
  > the agent better at choosing, because there is less to choose between.

  Note the second clause is not a sweetener: a smaller, well-matched toolset
  measurably improves tool selection. Cost and quality point the same way here,
  which is the easy case — §6's tenet only gets hard when they don't.

- **Derive `get_freshness_hash` from the `_get_snapshot` list.** Both read the
  same catalog; the per-tool GetItem fan-out could collapse into the snapshot
  that §4.1 makes unconditional. Opportunistic, unrelated to this feature's
  correctness, and would shave a real per-turn cost.

## 10. Backward compatibility, and the cleanup it defers

Backward compatibility is a **requirement of this feature, not a property we
hope it has**. It is cheap to get here and expensive to retrofit, so it is
stated as an acceptance criterion:

> **Deploying every PR in §8 to an environment where no tool is marked
> `alwaysOn` must be a no-op.** Byte-identical `toolConfig`, identical agent
> cache keys, identical SSE stream, no new DynamoDB writes, no change to the
> tool picker. Behaviour changes only once an admin flags a tool.

That property is what makes this safe to ship dark and turn on deliberately
(§8, PR-4), and it should be asserted by a test, not assumed.

### 10.1 Surface by surface

**Catalog rows.** `alwaysOn` absent reads back `False`, via the same
`item.get("alwaysOn", False)` shape `enabledByDefault` already uses
(`models.py:836`). No backfill, no dual-read, no migration. A row written by
new code and read by old code carries one extra attribute that old code
ignores.

**`MCPToolEntry`.** `_parse_mcp_tools` already tolerates three stored shapes
(entry dict, legacy `List[str]`, bare string). The new flag follows
`needs_approval` exactly: `bool(data.get("alwaysOn", False))`.

**Admin API.** `ToolCreateRequest` / `ToolUpdateRequest` gain
`Optional[bool] = None`. ⚠️ The update route dumps with
`model_dump(exclude_unset=True)` (`admin/tools/routes.py`), which is what makes
omission mean *"leave it alone"* rather than *"set it to False"*. An older
admin client that never sends the field must not silently clear it. **Do not
"simplify" that to a plain `model_dump()`** — this is the one place partial-
update semantics are load-bearing for compatibility.

**`GET /tools` → SPA.** `UserToolAccess.alwaysOn` is purely additive, and the
SPA and backend deploy independently (`frontend-deploy.yml` vs `backend.yml`),
so both skew directions must be safe — and are:

- old SPA bundle + new backend → unknown field ignored, today's toggle;
- new SPA bundle + old backend → `undefined` → falsy → today's toggle.

Neither direction renders a lock the other end cannot honour, which is the
failure mode worth protecting against (a lock the backend does not enforce is
worse than no lock at all).

**`enabled_tools` on the wire.** Shape unchanged. `_with_auto_enabled_tools`
returns **the same object** when there is nothing to add, so with no always-on
tools configured the list is not merely equal to today's but identical —
`None` stays `None`, and the agent cache key, the freshness hash and the
serialized `toolConfig` are untouched. This is why the no-op claim above is
structural rather than incidental.

**Agent cache key.** No new element. §4's design adds no dimension to
`_create_cache_key`; the union changes the *content* of `enabled_tools` when
active and nothing at all when inactive.

**Feature flag.** `ADMIN_ALWAYS_ON_TOOLS_ENABLED` is default-on with a kill
switch (unset or empty ⇒ on, house style). Default-on is safe here precisely
*because* the feature is inert without catalog data. The switch exists for the
case where tools have already been flagged and something is wrong: it reverts
to today's behaviour without an admin having to edit DynamoDB rows under
pressure.

**Scheduled runs and voice.** No payload change and no Lambda image change
(D5).

### 10.2 What is deliberately NOT backward compatible

Two behaviour changes are intended, and both are gated behind an admin flagging
a tool — neither fires on deploy:

- a user whose picker is entirely off now receives the always-on set rather
  than a tool-less agent (§5);
- template-derived Agents with no tool bindings gain the pinned tools (D4,
  PR-4).

These belong in the release notes. "Backward compatible on deploy, behaviour
change on enablement" is the honest summary.

### 10.3 The debt this takes on, and how to retire it

**The two-boolean encoding is a compatibility shim, not the shape we would
choose greenfield.** §2.2 keeps `enabled_by_default` + `always_on` with a
normalizing validator specifically to avoid migrating every catalog row, every
request/response model, four SPA models and the seeder. That is the right
trade *now*, and it is still debt: two booleans that must agree is the same
derived-field drift pattern `allowedAppRoles` already demonstrates in this
codebase.

⚠️ **Until the cleanup lands, the normalizing validator is load-bearing. Do not
delete it as redundant** — it is the only thing preventing
`enabledByDefault: false` + `alwaysOn: true`, and it must run on read as well
as write so a hand-written DynamoDB item cannot produce the invalid pair
either.

**Retirement plan.** Fold into the next change that already has to touch every
`TOOL#` row (a seeder rewrite, or a new required catalog field) rather than
spending a PR on it alone:

1. Introduce a single `toolEnablement` enum — `user_choice` / `default_on` /
   `always_on`.
2. Backfill `TOOL#` rows. Remember the seeder is the **only** writer of those
   rows, so it has to move in the same change or it will write the old shape
   back.
3. Drop the normalizing validator and both booleans from `ToolDefinition`,
   `ToolCreateRequest`, `ToolUpdateRequest` and `UserToolAccess`.
4. Collapse the admin form's *derived* three-way control into a real one bound
   to the enum, and update the four SPA models.
5. The invalid combination becomes unrepresentable rather than merely
   normalized — which is the whole point of doing it.

A second, smaller cleanup: once §9's "close the enforcement boundary" follow-up
lands (intersecting `enabled_tools` with the caller's grant set on the default
path), the RBAC filter inside always-on resolution becomes redundant with the
general one. Collapse them then, not before — two gates that agree are cheap,
and removing the specific one first would leave a window with neither.
