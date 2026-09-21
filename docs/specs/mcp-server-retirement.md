# Retiring an MCP server

**Status:** Runbook. Stages 0, 2, 3 and 4 work with today's code. Stage 1 needs
the small change in §7 to do anything at all — today `status` has no readers on
any path that matters.
**Scope:** A `TOOL#<id>` catalog row with `protocol: mcp_external` or `mcp`
(AgentCore Gateway), that one or more Agents already bind. Retiring a *built-in*
tool differs in one place only — §9.
**Refs:** `agent_binding_resolver._resolve_tools` is the fact the whole plan is
shaped around (§1); `docs/specs/admin-always-on-tools.md` §2.3 for the pin that
has to come off first; `docs/specs/agent-version-snapshots.md` for why a
published Agent cannot be fixed by its author alone (§5d).

---

## The question this answers

> Should retirement start by making the server not viewable / not bindable for
> new work, while keeping it functional for legacy Agents that already bind it?

**Yes — and it is the only safe first move.** But "not bindable" has to mean
*the picker will not offer it for a new selection*. It must **not** mean
"remove the grant" or "delete the row", because both of those are the last
step, not the first, and each fails in a different ugly way (§1).

The good news is that no new grant-layer primitive is needed. `ToolStatus`
already has the word (`DEPRECATED`); what is missing is a *reader* on the two
pickers. §7 is that reader — one backend field plus two SPA guards — and
it involves **no divergence between listing and enforcement**, which matters
because this repo has a standing rule against exactly that (§4).

---

## 1. The thing that decides the design

Revoking access to a bound tool **blocks** an Agent. It does not degrade it.

`_resolve_tools`
([`agent_binding_resolver.py:255`](../../backend/src/apis/inference_api/chat/agent_binding_resolver.py#L255))
re-checks every bound tool against the **invoking** user and raises
`AgentBindingBlockedError` on the first miss. The route turns that into a
conversational `stream_error` and the turn is over:

> This agent uses the tool **canvas_faculty**, which isn't available to your
> account. Ask an administrator for access, or use a different agent.

That is D5 "block-with-message, no silent drop", and it is correct behaviour —
an Agent composed of seven tools that quietly runs with six is a worse outcome
than a clear refusal. It just means revocation is a **loud, total** operation on
the bindings axis, while it is a silent narrowing everywhere else:

| Surface | Predicate | What happens when the tool becomes inaccessible |
|---|---|---|
| Plain-chat picker (`enabled_tools`) | `filter_requested_tools` ([`rbac/service.py:321`](../../backend/src/apis/shared/rbac/service.py#L321)) | silently narrowed out |
| Admin always-on pin | `resolve_always_on_tool_ids` → `filter_requested_tools` | silently not pinned |
| Scheduled run (`enabledTools` snapshot) | `filter_requested_tools` | silently narrowed out |
| Spreadsheet auto-enable | `can_access_tool` per id | silently skipped |
| **Agent `tool` binding** | `can_access_tool` in `_resolve_tools` | **whole turn blocked, with a message** |

So there are three levers, and they fail in three different ways:

| Lever | Effect on a bound Agent | Verdict |
|---|---|---|
| Revoke the grant (drop from `grantedTools`, clear `isPublic`) | Hard block, every turn, every invoker | **Last loud step.** Stage 3 |
| Hard-delete the `TOOL#` row, leave grants | `can_access_tool` still passes (the grant set is built from role records, not from the catalog), so `_resolve_tools` admits it — then `external_mcp_client` hits `if not tool: continue` ([`external_mcp_client.py:544`](../../backend/src/agents/main_agent/integrations/external_mcp_client.py#L544)) and the server is silently absent. The Agent runs, answers confidently, and has none of its tools | **The worst outcome, and it is what "just delete it" produces.** Never reach this state |
| Leave both, stop offering it in the pickers | Nothing changes for anyone who already has it | **First step.** Stage 1 |

The middle row is the reason the ordering in §6 is not negotiable: grants come
off *before* the row, never after.

---

## 2. `ToolStatus` today: vocabulary with no readers

`ToolStatus` (ACTIVE / DEPRECATED / DISABLED / COMING_SOON,
[`tools/models.py:124`](../../backend/src/apis/shared/tools/models.py#L124)) is
settable by an admin — the tool form has the dropdown
([`tool-form.page.ts:920`](../../frontend/ai.client/src/app/admin/tools/pages/tool-form.page.ts#L920)).
Verified empirically, here is every place it is read:

| Reader | Filters on status? |
|---|---|
| `repository.list_tools(status=…)` | Yes — but only when a caller passes one |
| `ToolCatalogService.get_all_tools(status=…)` → `GET /admin/tools/?status=` | Yes. **The only caller that passes a status.** Admin list page only |
| `ToolCatalogService._get_all_active_tools()` from `get_user_accessible_tools` ([`tools/service.py:87`](../../backend/src/apis/app_api/tools/service.py#L87)) | **No.** Passes `status=None`. The name is a lie |
| `freshness._get_snapshot` → `get_public_tool_ids` / `get_all_tool_ids` / `get_always_on_tool_ids` | **No — deliberately.** The docstring says so: enforcement and the picker must agree about which tools `isPublic` reaches |
| `AppRoleService` (every gate) | **No.** Never reads the catalog row at all, only role records ∪ the public set |
| `agents/` runtime — `base_agent`, `external_mcp_client`, `tool_filter`, `gateway_integration` | **No.** Grep for `.status` under `backend/src/agents/` returns HTTP status codes and one document-rehydration check. Nothing tool-catalog |
| `BindableItem.meta` for `kind=tool` ([`bindable_catalog.py:111`](../../backend/src/apis/app_api/agent_designer/services/bindable_catalog.py#L111)) | **Does not carry `status` at all.** The Agent Designer picker is structurally blind to it |
| SPA `reconcileToolRefs` ([`tool-ref-reconcile.ts`](../../frontend/ai.client/src/app/agents/agent-form/tool-ref-reconcile.ts)) | Yes — the one real consumer. Flags a non-`active` ref on *template prefill*, and still applies it |

Two consequences worth stating before anyone's first move:

1. **`status: disabled` does nothing.** Neither access, nor listing, nor the
   runtime reads it. So `DELETE /api/admin/tools/{id}` without `hard=true`
   (`soft_delete_tool`, which sets `status: DISABLED`) is, with respect to
   everything a user can observe, **a no-op**. It will be someone's instinct.
   It retires nothing.
2. The word we need already exists. `DEPRECATED` needs readers, not a new enum
   value. §7 adds two.

---

## 3. `isPublic` is a real grant — rank it with revocation, not with hiding

`_tool_grant_set` ([`rbac/service.py:251`](../../backend/src/apis/shared/rbac/service.py#L251))
unions `get_public_tool_ids()` into the caller's role grant, and every tool gate
goes through it. `test_public_tool_grants.py` is the regression cover for the
era when it did not.

So for a public MCP server, **clearing `isPublic` is a revocation of every
user's grant at once** and therefore a hard block for every Agent binding it.
It belongs in Stage 3 alongside `grantedTools` edits — never in Stage 1 as a
"just make it less visible" move. (It *also* hides it from the picker, which is
what makes it tempting.)

---

## 4. Which predicates would have to diverge, and whether that is safe

Name them precisely.

**The listing predicate** is `ToolCatalogService.get_user_accessible_tools(user)`
→ `_get_all_active_tools()` (all rows, no status filter) + `_compute_granted_by`
(`is_public` ∨ `"*"` ∨ `tool_id in permissions.tools`). One function, **three**
consumers:

- `GET /tools/` — the plain-chat tool picker
- `bindable_catalog._list_tools` — the Agent Designer palette
- `binding_validation._validate_tool` — the design-time **write** check
  ([`binding_validation.py:224`](../../backend/src/apis/app_api/agent_designer/services/binding_validation.py#L224))

**The enforcement predicate** is `AppRoleService.can_access_tool` →
`_tool_grant_set` (role grant ∪ public set).

The standing rule — stated in the `rbac/service.py` module docstring, in
`freshness.get_public_tool_ids`, and enforced by `test_public_tool_grants.py` —
forbids these two disagreeing. Read its rationale, though: the bug it exists to
close is **list-then-deny**, a tool the picker offers and the gate then refuses.
Retirement wants the opposite arrow: **hide-then-still-allow**.

Those two directions are not symmetric and should not be governed by one rule.
List-then-deny shows a user an affordance that fails. Hide-then-allow hides an
affordance that would have worked. Only the first is a bug; the second is the
definition of grandfathering. **A deliberate hide-then-allow divergence is
safe** — with one qualification, which is the whole reason §7 does not do it at
the grant layer:

> **You cannot get it by status-filtering `get_user_accessible_tools`,** because
> `_validate_tool` reads that same function. Filter it, and an author who opens
> an Agent binding the retiring server and changes one word of its instructions
> gets `403 You do not have access to tool 'canvas_faculty'` — for a tool their
> Agent can still run. They are not *stranded* (validation only inspects the
> bindings actually submitted, so removing the binding always saves), but they
> are lied to at exactly the moment we are asking them to cooperate.

Two routes were considered and one declined:

| Route | What it needs | Verdict |
|---|---|---|
| **Grant-layer.** A `RETIRING` status that `get_user_accessible_tools` filters out while `can_access_tool` still admits | Splitting `_validate_tool` off the palette source and giving it the record's **prior** bindings so a grandfathered ref validates while a newly-added one does not. That prior-bindings argument is a genuinely new primitive — `validate_agent_write` is currently stateless with respect to the stored record | **Declined.** Larger change, and it makes the palette and the write validator disagree, which is a second divergence with no story behind it |
| **Display-layer.** Carry `status` on `BindableItem.meta`, and have the pickers refuse to *add* a non-`active` ref while leaving an already-selected one alone | One field on a free-form dict, two SPA guards | **Adopted (§7).** Listing, write-validation and enforcement keep reading one grant set. The only thing that changes is what a picker offers for a **new** selection |

The display-layer route is not a security boundary — a crafted `PUT /agents/{id}`
can still add the binding. That is fine: the threat model here is *accidental
new adoption*, not a determined author. The security boundary stays where it
is, in `can_access_tool`, and it moves only in Stage 3.

---

## 5. Enumerating the blast radius

Five populations. Do all five before touching anything — Stage 0 exists so that
the count of affected Agents is a number in a ticket, not a surprise in Stage 3.

### a. Roles that grant it

```bash
curl -s "$APP_API/api/admin/tools/$TOOL_ID/roles" | jq '.roles[].roleId'
```

Backed by GSI2 `ToolRoleMappingIndex` (`GSI2PK = TOOL#<id>`).

> ⚠️ **Blind to the wildcard.** A role whose `grantedTools` contains `*` writes
> `GSI2PK = "TOOL#*"` ([`seed_bootstrap_data.py:690`](../../backend/scripts/seed_bootstrap_data.py#L690))
> and never appears under `TOOL#<id>`. A "0 roles" answer does **not** mean
> nobody is granted. List wildcard holders separately:
>
> ```bash
> curl -s "$APP_API/api/admin/roles" | jq -r '.roles[] | select(.grantedTools | index("*")) | .roleId'
> ```

### b. `isPublic`

```bash
curl -s "$APP_API/api/admin/tools/$TOOL_ID" | jq '{isPublic, status, alwaysOn, protocol}'
```

`isPublic: true` ⇒ every authenticated user is granted, and (a) told you almost
nothing.

### c. Agents that bind it — bare **and** scoped

There is no reverse index from tool to Agent. Scan the assistants table. One
scan covers both populations, because a version snapshot shares the Agent's
partition key (`PK = AST#<id>`, `SK = VERSION#00000003`) with the live record
(`SK = METADATA`):

```bash
aws dynamodb scan --table-name "$ASSISTANTS_TABLE" \
  --projection-expression "PK,SK,ownerId,#n,visibility,listing,bindings" \
  --expression-attribute-names '{"#n":"name"}' \
  --output json \
| jq --arg t "$TOOL_ID" '
    .Items[]
    | select([.bindings.L[]?.M
              | select(.kind.S == "tool")
              | .ref.S
              | select(. == $t or startswith($t + "::"))] | length > 0)
    | {pk: .PK.S, sk: .SK.S, name: .name.S, owner: .ownerId.S,
       visibility: .visibility.S,
       listingState: .listing.M.state.S,
       publishedVersion: .listing.M.publishedVersion.N,
       refs: [.bindings.L[].M | select(.kind.S=="tool") | .ref.S]}'
```

The `startswith($t + "::")` clause is not optional. A scoped ref
(`canvas_faculty::list_assignments`,
[`scoped_ids.py`](../../backend/src/apis/shared/tools/scoped_ids.py)) binds a
subset of the same server, blocks on the same `can_access_tool` call (which is
keyed on the base id), and is invisible to an equality match.

### d. Which of those are published — and therefore not fixable by their author

`resolve_invocation_agent`
([`version_resolution.py:80`](../../backend/src/apis/shared/assistants/version_resolution.py#L80)):

| Invoker | Runs |
|---|---|
| Owner | their live draft |
| Anyone else, `listing.publishedVersion` set | **the frozen `AgentVersion` snapshot** |
| Anyone else, nothing published | the live record |

`AgentVersion` freezes `bindings`
([`assistants/models.py:239`](../../backend/src/apis/shared/assistants/models.py#L239)).
So for a published Agent, **the author removing the binding from their draft
fixes it for themselves and for nobody else.** The snapshot keeps the retired
ref until a new version is submitted *and* approved.

This is the single most expensive thing to discover late. Two admin escape
hatches exist — see Stage 2.

### e. Everything else holding the id

| Holder | Where | Severity if left |
|---|---|---|
| `alwaysOn` pin (bare or `base::name`) | the catalog row's own `alwaysOn`, or an `mcpConfig.tools[].alwaysOn` entry | **Must come off in Stage 1.** A pin is unioned into every granted user's turn; leaving it means the retiring server is being *pushed* while you are trying to withdraw it |
| Admin agent templates | `agent_templates` rows, `bindings[]` | **Must come off in Stage 1.** A template mints a fresh binding every time someone clicks "Start from a template" |
| Scheduled prompts | `enabledTools` snapshot | Low — silently narrowed at run time |
| `UserToolPreference` rows | `toolPreferences` map keys | None. Inert leftovers |
| Sessions | `enabledTools` on session rows | None |

---

## 6. The staged sequence

Two lines run through this, and they are in different places. Say both out
loud in the ticket:

- **The blast line is Stage 3.** It is the first stage a user can experience as
  a failure.
- **The point of no return is Stage 4.** It is the first stage whose *state*
  cannot be restored. Stage 3 is reversible in about a minute (§ Stage 3
  rollback); what is not reversible about it is the errors already shown.

### Stage 0 — Inventory (no user-visible change)

Run all of §5. Record in the retirement ticket: granting roles (including
wildcard holders), `isPublic`, the full Agent list split into *live-record* and
*published-snapshot* populations, owners' emails, the `alwaysOn` state, and any
template refs.

Export the row itself now, not at Stage 4 — an `mcp_external` row's
`mcpConfig` (endpoint URL, transport, auth type, `tokenExchangeAudience`,
`forwardAuthToken`, and the curated `tools[]` list with its per-tool
`needsApproval` / `alwaysOn` flags) was hand-entered by an admin and exists
nowhere else:

```bash
curl -s "$APP_API/api/admin/tools/$TOOL_ID" > retirement-$TOOL_ID-metadata.json
aws dynamodb get-item --table-name "$APP_ROLES_TABLE" \
  --key "{\"PK\":{\"S\":\"TOOL#$TOOL_ID\"},\"SK\":{\"S\":\"CAPABILITIES\"}}" \
  > retirement-$TOOL_ID-capabilities.json
```

**Rollback:** n/a.

### Stage 1 — Stop new adoption. Existing bindings untouched

Three changes, none of which touches a grant or the row's existence:

1. **Unpin.** Clear `alwaysOn` on the row and on every `mcpConfig.tools[]`
   entry. `PUT /api/admin/tools/{id}`, or the admin tool form.
2. **De-template.** Remove every `{"kind":"tool","ref":"<id>…"}` binding from
   admin agent templates.
3. **Set `status: deprecated`** on the row — and ship §7 so that means
   something. Until §7 lands, this step is cosmetic and Stage 1 buys only (1)
   and (2).

What does **not** change: `grantedTools`, `isPublic`, the row, the Gateway
target. `can_access_tool` returns exactly what it returned yesterday, so
**every Agent that binds this server keeps working, for every invoker,
including from a frozen snapshot.** Plain-chat users who have it toggled on keep
it (§7 gates *new* selection, not an existing one).

**Tell the Agent owners now**, not at Stage 3 — this is the whole point of the
stage. Template in §8.

**Rollback:** set `status` back to `active`; re-pin; restore the template
bindings. Fully reversible, seconds, no user-visible trace.

**Cost note.** Any admin write to the row bumps its `updated_at`, which moves
`freshness.get_freshness_hash` and therefore the agent-cache key, so the next
turn of every live session touching this server rebuilds its `Agent` and pays
one Bedrock cache write. Unavoidable and one-off — but it means Stages 1 and 3
should each be a *single* edit, not a morning of fiddling with the tool form.
Stage 3 additionally changes `permissions.tools`, which reaches `toolConfig`, so
affected users pay a second one-off prefix re-write there.

### Stage 2 — Drive the binding count to zero

Chase the list from §5c. For each Agent:

- **Live-record Agents** (no `publishedVersion`): the owner edits the Agent and
  removes the binding. This always saves, even after the owner has lost access
  to the tool, because `validate_agent_write` only inspects the bindings
  actually submitted and the removed ref is not among them.
- **Published Agents**: the owner removes the binding *and* resubmits; an admin
  approves. Until that approval lands, non-owner invokers still run the old
  snapshot.

Two admin escape hatches when an owner is unresponsive or review will not land
in time:

- **Takedown** (`POST /api/admin/agents/{id}/takedown`). This clears
  `publishedVersion` ([`listing_service.py:1003`](../../backend/src/apis/app_api/agent_designer/services/listing_service.py#L1003)),
  which makes `resolve_invocation_agent` fall through to the **live record** for
  everyone. So a takedown *un-freezes* the snapshot: if the author has already
  fixed their draft, takedown makes the fix effective immediately. It is a
  delisting, not a revocation — pins and direct links keep working.
- **Rollback** (`POST /api/admin/agents/{id}/rollback`) is *not* a fix here.
  Older versions bind the same server.

Track the §5c scan to zero. Re-run it; do not trust the ticket.

**Rollback:** still trivial — nothing has been revoked.

### Stage 3 — Revoke. **The blast line**

Only once §5c returns zero, or once the remaining holdouts have been explicitly
accepted as breakage by their owners:

1. Remove the id from every role's `grantedTools`
   (`POST /api/admin/tools/{id}/roles/remove`, which writes through to each
   role record — the `allowedAppRoles` field on the tool is a derived
   projection and setting it grants nothing).
2. Set `isPublic: false`.
3. Confirm no wildcard role is still in play. A `*` grant keeps admins working
   past this step; that is expected and fine, but it means an admin's smoke test
   proves nothing about an ordinary user.

From this moment any Agent still binding the server hard-blocks for every
invoker on every turn, with the §1 message.

**Rollback:** re-add the grant. Access restores within one `AppRoleCache` cycle
plus the 10 s `freshness` TTL — call it a minute in the worst case. The state is
recoverable; the error messages already delivered are not. That asymmetry is why
Stage 3 gets its own line and its own announcement.

### Stage 4 — Remove the row. **The point of no return**

Order matters: grants are already gone (Stage 3), so there is no window in which
the §1 "silent capability loss" state exists.

```bash
curl -X DELETE "$APP_API/api/admin/tools/$TOOL_ID?hard=true" -H "..."
```

For `protocol: mcp` (Gateway), `delete_tool` deletes the live AgentCore Gateway
target *before* the row ([`tools/service.py:663`](../../backend/src/apis/app_api/tools/service.py#L663)),
tolerating a 404. **That AWS call is irreversible**; re-creating the target
means re-running discovery and re-issuing credentials.

Three things `delete_tool` does **not** clean up. Do them by hand:

| Leftover | Why it survives | Action |
|---|---|---|
| `PK=TOOL#<id>, SK=CAPABILITIES` | `repository.delete_tool` deletes only `SK=METADATA`. `delete_capabilities` exists and has **zero callers** | `aws dynamodb delete-item` on that key |
| `ROLE#<role>/TOOL_GRANT#<id>` rows | `delete_tool` does not cascade into RBAC | Already gone if Stage 3 was done properly. **Verify** — a surviving grant plus a missing row is the §1 silent-failure state |
| `toolPreferences` keys, scheduled-run `enabledTools` entries | Never reconciled against the catalog | Leave them. Inert |

**Rollback:** re-create the row from `retirement-<id>-metadata.json` (Stage 0),
re-run discovery, re-create the Gateway target, re-add grants. Possible but it
is a rebuild, not an undo — and if Stage 0's export was skipped, the endpoint
and auth configuration are simply gone.

---

## 7. The change Stage 1 needs

Small, additive, and involves no grant-layer divergence.

**Backend** — one field, in `bindable_catalog._list_tools`:

```python
meta={
    "category": t.category,
    "protocol": t.protocol,
    "status": t.status,          # ← new; UserToolAccess already carries it
    "requiresOauthProvider": t.requires_oauth_provider,
    "serverTools": [...],
},
```

`BindableItem.meta` is a free-form `Dict[str, Any]`, so this breaks no
contract. `GET /tools/` already returns `status` on every `UserToolAccess`
([`tools/service.py:160`](../../backend/src/apis/app_api/tools/service.py#L160)),
so the chat picker needs no backend change at all.

**SPA** — two guards, both "refuse to *add*, never remove":

1. Agent Designer tool picker: a `status !== 'active'` entry renders with a
   "Being retired" badge and is not selectable **unless it is already in
   `bindings`**, in which case it renders selected, with the badge, and a
   tooltip pointing at the retirement notice.
2. Plain-chat tool picker: same rule against `Tool.status`.

**Do not** filter these out of the list. An author who opens an Agent that binds
a retiring server must *see* the binding — a ref that silently vanished from the
picker while remaining in the record is how a "why did my Agent break?" ticket
gets written three weeks later.

**Do not** touch `get_user_accessible_tools`, `_tool_grant_set`,
`get_public_tool_ids` or `_validate_tool`. Everything in this section is
presentation. `test_public_tool_grants.py` and its rule stay intact.

Worth adding while there: `reconcileToolRefs` already flags non-`active` refs on
template prefill and still applies them — the right behaviour, and free
precedent for the badge copy.

---

## 8. What to tell Agent authors

**Stage 1 — to every owner in §5c, and to the tool's known users:**

> **`<Server>` is being retired on `<date>`.**
> Nothing changes today. Your agent **`<Agent name>`** uses it and will keep
> working exactly as it does now.
> From today it can't be added to new agents, and it no longer appears as a
> choice in the tool picker.
> Before `<date>` please remove it from `<Agent name>` — and if your agent is
> published, resubmit it so the change reaches the people using it. After
> `<date>` an agent that still uses it will refuse to run and will tell your
> users to contact an administrator.
> Replacement: `<the replacement, or "none — here is what to do instead">`.

**Stage 2 — reminder to holdouts, and separately to published-Agent owners:**

> Your agent **`<name>`** is published, so the people using it are running the
> reviewed snapshot — removing the tool from your draft is not enough on its
> own. Please resubmit; we will prioritise the review. If you would rather not
> resubmit, tell us and we will take the listing down, which makes your current
> draft live for everyone immediately.

**Stage 3 — before revoking, to anyone still bound:**

> `<Server>` access is being removed `<date/time>`. `<N>` agents still use it and
> **will stop running** at that point, showing their users: *"This agent uses the
> tool `<id>`, which isn't available to your account."* This is the last notice.

**Stage 4:** internal only. No user-facing change beyond Stage 3.

---

## 9. Retiring a built-in tool instead (the seeder)

`DEFAULT_TOOLS` in `seed_bootstrap_data.py` contains **fourteen local/AWS-SDK
tool ids and no MCP servers**. Every `mcp` / `mcp_external` row is created by an
admin through `POST /admin/tools/`, so for the case this runbook covers the
seeder is **not** a resurrection risk.

It is for a built-in. `seed_default_tools`
([`seed_bootstrap_data.py:848`](../../backend/scripts/seed_bootstrap_data.py#L848))
does `get_item` → skip-if-present → else `put_item` with a hard-coded
`"status": "active"`. So a hard-deleted built-in row **comes back, active, on the
next bootstrap run**, and its `status: deprecated` is not preserved either way.
Retiring a built-in therefore adds one step to Stage 4: delete its `DEFAULT_TOOLS`
entry *and* its `TOOL_CATALOG` entry (`agents/main_agent/tools/tool_catalog.py`)
in the same PR, because `test_seed_matches_tool_catalog.py` asserts that a
catalogued tool without a seed row is a defect.

---

## 10. Follow-ups this runbook wants and does not have

1. **No reverse index tool → Agent.** §5c is a full table scan. Fine at today's
   Agent count; if that changes, the cheapest fix is a sparse GSI written from
   `bindings` at Agent-write time — or an admin endpoint that does the scan once
   and caches, so the runbook is a button rather than a `jq` incantation.
2. **`get_roles_for_tool` is blind to wildcard grants** (§5a). The "0 roles"
   badge on the admin tool page inherits that blindness and reads as "nobody has
   this", which is exactly wrong for the most-granted tools.
3. **`delete_tool` does not cascade.** It leaves `TOOL_GRANT#` rows and the
   `CAPABILITIES` row behind, and `delete_capabilities` has no callers. The
   grant leftovers are what make "just delete it" produce §1's silent-failure
   state.
4. **`soft_delete_tool` is a no-op** with respect to everything observable
   (§2). It should either do something or be removed; today it reads like a
   safety feature and is not one.
5. **Deprecated bindings are invisible to admins.** There is no view answering
   "which Agents bind a non-`active` tool?", which is the report Stage 2 is
   actually managed from.
