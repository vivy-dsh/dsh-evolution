# dsh-evolution

The evolution console and the **owner of evolution records**: Evidence,
Proposal, Validation and PublicationRecord. Everything else in this plugin is a
read-only view of somebody else's data.

`src/records.mjs` keeps those four record kinds in one append-only SQLite
database and serves them over the plugin's loopback API. The harness views
(`src/harness.mjs`) still read `continual-harness` state directly, and
`src/config.mjs` still edits the profile through `configEditor`.

The panel no longer shows an automatic-refinement switch, and the config
whitelist in `src/config.mjs` no longer accepts `autoRefine.*` or
`auditReviews`: both keys belong to the orchestrator now, and writing them
through this panel would suggest a control that starts nothing. Historical
harness entries and reviews remain readable, and an explicit `harness_refine`
call still writes them exactly as before.

## Where the data lives

```
.artifacts/dsh-home/evolution/evolution.db      0600, WAL
.artifacts/dsh-home/evolution/backups/          pre-migration snapshots, 0600
```

`DSH_EVOLUTION_STATE_DIR` overrides the directory (absolute paths only);
otherwise it is `<DSH_HOME>/evolution`. The directory is `0700`.

The store opens **lazily**: `apply()` imports nothing, creates no directory and
opens no file. The first read or write request opens it, and a failed open is
not cached, so fixing the environment is enough to retry. If `node:sqlite` is
unavailable the record routes report `EVOLUTION_SQLITE_UNAVAILABLE` (503) while
the harness views keep working — disabling or breaking Evolution must not take
another domain down.

Pragmas: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`,
`busy_timeout=2000`, `application_id=0x45564C31` (`EVL1`). A file whose
`application_id` belongs to someone else, or an empty file that already holds
unfamiliar tables, is refused with `EVOLUTION_STORE_FOREIGN` and its bytes are
left alone. `user_version` above the supported range is refused the same way.

One launcher process may write this file. Concurrent processes are not
supported (`busy_timeout` only absorbs a short overlap).

## Four append-only tables

`evidence`, `proposal`, `validation`, `publication`. **A row is never updated
or deleted.** A state change appends a new `version` row with the same `id`;
the current state is the highest version. `BEFORE UPDATE` / `BEFORE DELETE`
triggers on all four tables raise `evolution_history_append_only`, so history
cannot be rewritten even by a caller holding the raw handle.

| Record | What it is | Key rules |
| --- | --- | --- |
| Evidence | an observation worth acting on | `source` whitelist; `recap`/`dream`/`model_self_review` are derived only, must cite `derivedFrom`, and can never be a proposal's sole basis; `ticket_id` optional |
| Proposal | one candidate change | `ticket_id` required; `(candidateKind, ownerKind)` must be a legal pair; only the candidate **digest** is stored, never its body |
| Validation | a check run against one proposal version | must bind `proposalId` + `proposalDigest` + `candidateDigest`; checks must cover the owner's `minChecks`; `ticket_id` must equal the proposal's |
| PublicationRecord | proof an owner applied a validated candidate | `ticket_id` required; `publish` needs a `passed` validation with matching digests; `live` requires an `owner_ref`; one validation supports exactly one publication |

Candidate → owner pairs (docs/architecture.md:382-389): `persona`→`laputa`,
`active_memory`→`actmem`, `long_term_knowledge`→`mempalace`, `skill`→
`skill_owner`, `behaviour_prompt`→`prompt_owner`, `subagent`→`agent_registry`.

## Identity, digests and compare-and-swap

Ids are content addresses, never timestamps:
`deriveRecordId(prefix, identity)` = `prefix_` + 32 hex of the canonical JSON
digest of the identity fields. `canonicalJson` sorts object keys recursively,
keeps array order, and refuses anything above `CANONICAL_LIMIT_BYTES`
(256 KB — the same ceiling as the HTTP body limit) with
`EVOLUTION_LIMIT_EXCEEDED`.

| Record | id identity | replay / conflict |
| --- | --- | --- |
| evidence | `subjectId, source, dedupeKey` | same key + same digest → `{created:false}`; same key + different digest → `EVOLUTION_EVIDENCE_CONFLICT` |
| proposal | `subjectId, ticketId, candidateKind, ownerKind, assetScope, candidateDigest` | new proposal may omit `expectedProposalDigest`; advancing one must match the head digest → else `EVOLUTION_CONFLICT` |
| validation | `proposalId, proposalDigest, candidateDigest, normalized checks` | a validation bound to a superseded digest is `EVOLUTION_STALE_VALIDATION` at publish time |
| publication | `subjectId, proposalId, validationId, purpose` (+ `restoredFromPublicationId` for a rollback) | identical publish replays; a second content over the same validation is `EVOLUTION_VALIDATION_CONSUMED`; a stale `expectedLivePublicationId` is `EVOLUTION_CONFLICT` |

Digests exclude `provenance.at` and the writer's own metadata (validation
`runner`/`approvalRef`/`notes`, publication `approvalRefs`/`actorRef`/
`publishedAt`), so retrying the same call does not change the address.

## Publishing and rollback

`publish()` checks, in order: the proposal exists → the owner supports versioned
writes (`laputa`, `actmem` and `mempalace` here; the generic route still refuses
MemPalace and points to its own knowledge path) → a `validationId` was supplied →
`owner_ref` carries **only** the fields that owner declared (references, never
the bytes) → nothing has already been published under this record's id (an
identical publish replays as `created:false`; different content over the same
validation is `EVOLUTION_VALIDATION_CONSUMED`) → `expectedProposalDigest`
matches the head → the validation exists, belongs to this proposal, says
`passed` and binds both digests → the state machine allows `published` →
`expectedLivePublicationId` matches the current live row. Then one SAVEPOINT
appends the proposal's `published` version, retires the previous live row as
`superseded`, and inserts the new `live` row.

The replay lookup runs before the digest CAS on purpose: publishing appends a
`published` version to the proposal, so the head digest of an already-published
candidate legitimately differs from the one the original caller held. Deciding
replay from the immutable id plus the caller's owner reference is what keeps a
retry idempotent instead of turning it into a spurious 409.

A publication that failed is not retried blindly: `validation_id` is unique, so
recovery means running a new Validation. That is deliberate — an unknown result
must never buy a second silent write.

`rollback()` appends: the retired live row gains a `rolled_back` version and a
new `live` row with `purpose='rollback'` and
`restoredFromPublicationId=<the earlier publish>`. Nothing is deleted, and the
restored historical row keeps its own version trail.

`GET /verify` (or `store.verifyHistory()`) re-derives every stored digest,
walks the links, checks the guard triggers are still installed and reports
`integrity_check`. A row rewritten by hand shows up as a `digestMismatches`
entry instead of silently shipping.

## Owner gate

`OWNERS` records what each owner can do today. `versionedWrite: false` means
the candidate stays a Proposal and `publish()` answers
`EVOLUTION_OWNER_UNSUPPORTED` with a hint naming the missing capability.
`mempalace.versionedWrite` is now `true`: MemPalace versions long-term knowledge
through its own `knowledge_commits` ledger, so Evolution can publish and roll
back knowledge — but only through the owner (below). `skill_owner`,
`prompt_owner` and `agent_registry` stay `false`, so a "published" record for
them is unrepresentable — which is the point.

## Publishing and rolling back knowledge

MemPalace knowledge is written by its own ledger, never self-reported:

- `publish()` and `rollback()` refuse a `mempalace` record with
  `EVOLUTION_OWNER_API_REQUIRED` (HTTP 409) unless the call arrived through the
  knowledge path. A caller-supplied `ownerRef` is never trusted for this owner.
- `POST /publish-knowledge` (`store.publishKnowledge`) preflights the proposal,
  its validation, the candidate body, the digests and the `baseRevision`
  compare-and-swap anchor, then commits through the owner with a deterministic
  `commitKey`. An owner RPC whose outcome is unknown is reconciled through
  `status({ commitKeys })` instead of being retried blindly; a commit that does
  not return a complete live reference is a failure. If the Evolution
  publication record cannot be written afterwards, the commit is compensated
  back to `baseRevision` and the call reports `EVOLUTION_OWNER_FAILED`.
- `POST /rollback-knowledge` (`store.rollbackKnowledge`) rolls the owner back to
  the target publication's revision, then appends the rollback record. A
  failure to write that record is **not** auto-compensated: the error reports
  `EVOLUTION_OWNER_FAILED` with the deterministic `commitKey`, and re-invoking
  the same inputs completes the record safely because the owner rollback is
  idempotent by `commitKey`.
- Replaying a completed `publish-knowledge` is refused with
  `EVOLUTION_CONFLICT`: publishing advanced the proposal head digest. Reconcile
  through the publication list or `knowledgeStatus({ commitKeys })` instead of
  re-invoking.
- Rollback revisions in MemPalace compute their digest with empty `checks` and
  are exempt from the four-check gate by design; Evolution still records the
  owner reference and digest the owner returns.

## HTTP API

Everything lives under `/dsh-evolution/api` behind the existing guards:
loopback host, same-origin for non-GET, and `connection.requestRejection`. No
new security boundary, no custom header. Operator identity travels in
`provenance.actor`.

Reads: `/store`, `/summary`, `/records?ticket_id=&kind=&state=&limit=&offset=`,
`/evidence`, `/proposals`, `/proposal?id=&history=`, `/validations?proposal_id=`,
`/publications`, `/publication?id=`, `/verify?limit=`.

Writes (JSON, camelCase or snake_case keys): `POST /evidence`, `POST /proposal`
(create, or advance when `toState` is present), `POST /validation`,
`POST /publish`, `POST /rollback`, `POST /publish-knowledge`,
`POST /rollback-knowledge`. The two knowledge routes take no `ownerRef`: they
call MemPalace's internal IPC and record what the owner returns.

`/overview` now carries an `evolution` block from `summarySafe()`: if the store
cannot open, the panel still gets HTTP 200 and `evolution.available === false`.

Status mapping: 503 for `EVOLUTION_SQLITE_UNAVAILABLE`,
`EVOLUTION_STORE_UNAVAILABLE`, `SUBJECT_UNAVAILABLE`; 409 for conflicts,
foreign files, unsupported schema, append-only refusals, already-live, subject
mismatch and `EVOLUTION_OWNER_API_REQUIRED`; 404 for `EVOLUTION_NOT_FOUND`; 422
for invalid records, missing tickets, validation and owner refusals; 413 for the
byte ceiling; 502 for `EVOLUTION_OWNER_FAILED`; 500 only for
`EVOLUTION_STATE_CORRUPT`. Every refusal carries a Chinese operator hint.

## 记录浏览

The panel's **进化记录** page is a read-only browse of the record store, keyed by
Superagent ticket. Enter a `Ticket ID` and optionally one record kind; the page
issues `GET /records?ticket_id=…&limit=200&kind=…` and renders the four groups as
证据 / 提案 / 验证 / 发布.

A proposal or publication row expands its version history through
`GET /proposal?id=…&history=1` or `GET /publication?id=…&history=1`, which returns
the head record plus every earlier version. Evidence and validation have no
detail endpoint, so those two groups stay list-only.

Both reads are GET-only and carry an `AbortController` signal, so a new query, a
refresh, or leaving the tab cancels the in-flight request. The page offers no
publish, rollback, or edit: those remain on the record-write routes.

The store currently has **no runtime producer**: nothing calls `/evidence` or
`/proposal` on a normal session, so this page stays empty in practice. Human
approvals are recorded by the owners instead — skill decisions in
`$DSH_HOME/harness/skill-owner/decisions` (shown in **审批 → 已处置**) and persona
candidates in Laputa's candidate directory (shown in **人格 → 提案**). The empty
state says so explicitly; wiring the owners into the record store is a separate
design change, not a panel bug.

The **审批** page reads `GET /dsh-continual-harness/api/pending` (pending and
decided candidates with rendered bundles) and posts `/decide` and `/rollback`.
Each request is loopback-only, same-origin, session-guarded and carries the
reviewed bundle digest, so the panel cannot approve content it did not show.

## Boundaries

- Evolution does not hold asset bodies. Personas live in Laputa, active memory
  in the memory plugin, long-term knowledge in MemPalace. Records store digests
  and owner references only (docs/architecture.md invariant #11).
- Evolution does not run Superagent tasks and does not mirror their lifecycle.
  `ticket_id` is a text join key; a dangling one is allowed, and the panel must
  query Superagent for task state (invariant #7).
- `tests/ownership-boundaries.test.mjs` asserts that `node:sqlite` appears only
  in `records.mjs`, that no other domain references `evolution.db`, and that
  this plugin reaches no other domain's source or state.
- The panel (`src/client.js`) browses records read-only through
  `GET /dsh-evolution/api/records?ticket_id=` and the per-record history routes;
  it holds no record-write control. The Superagent Ticket detail page (E5-S4) is
  the second reader of the same ticket-keyed query.
- Model-side access goes in-process through `dsh-evolution/records`
  (`package.json` `exports`), not over HTTP.

## IPC 端点（E4-S7 已落地）

- `_shared/ipc.mjs` 的 `names` 现含 `evolution`，`errorCodes` 有 `evolution: /^EVOLUTION_/`，因此组件的领域错误码可透传（不再一律降级为 `COMPONENT_REQUEST_FAILED`）。
- `src/internal.mjs` 经 `registerComponentInternal` 暴露回环端点：`POST /evidence` → `store.recordEvidence(body)`、`POST /proposal` → 有 `proposalId` 走 `advanceProposal` 否则 `upsertProposal`。只经 loopback + `x-component-token`，不新增公开 HTTP 写路由；store 仍为懒打开，`apply` 不建库（只发布 `<home>/evolution/runtime.json`）。
- 首个调用方计划是 `dsh-continual-harness`（E4-S7）：它把跨域候选投递为 Evidence + Proposal，不直接打开 `evolution.db`。**当前尚未接线**：`owner-candidates.ts` 的 `decorateWithOwnerCandidates` 已实现并有单测，但 `src/index.ts` 没有调用它，因此记录库仍是 0 行。

## Provenance and license

This repository was one module inside the `dsh-superagent-template` workspace and is now versioned on its own.

- **Source**: original work; no third-party code was ported.
- **Collaborates with**: `dsh-continual-harness` (MIT) — this console reads that plugin's state and edits its
  profile configuration, and never writes outside the records it owns.
