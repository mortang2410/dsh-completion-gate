# Skeleton: catalog items are adoption-only, and the gate tracks only direct file edits

- status: revised
- mode: design
- spec: docs/work/k42t-adoption-and-direct-edits/spec.md (working tree; last commit 25b20ca)
- scope: lib/changes.js, lib/tracker.js, lib/report.js, lib/index.js, tests/
- grill: kata personal#k42t comments, boards r97or7qn18kesp47 and zwv6qytlw6wv63xp

## Requirements map

| Id | Requirement | Spec anchor | Kind |
|----|-------------|-------------|------|
| R1 | An item obligates the session only when the session states it; an unstated item is history. | Spec, Solution; US1, US10 | behaviour |
| R2 | The report shows stated items with their states and, when the count is positive, one summary line naming the count of unstated items. | Spec, Implementation Decisions; US2 | behaviour |
| R3 | A stated item keeps its state; an assumed item without a reason stays unfinished. | Spec, Implementation Decisions; US3, US4 | behaviour |
| R4 | A file obligates the session only when the host recorder lists it and a root-session `write`, `edit`, or `str_replace_editor` call names it. | Spec, Solution; US5, US6, US7, US8 | behaviour |
| R5 | The gate still detects changes automatically from the host recorder and the session's own tool calls. | Spec, Solution; US9 | interface |
| R6 | The `unrelated` mark stays as an audit note. | Spec, Implementation Decisions; US11 | behaviour |
| R7 | The catalog keeps every item and its `proves` note. | Spec, Implementation Decisions; US12 | data |
| R8 | Tests fail when an unstated item is reported as unfinished or a shell-command file is tracked. | Spec, Testing Decisions; US13 | verification |

## Modules

| Id | Path | Responsibility | Allowed deps | Forbidden deps | Exposed surface |
|----|------|----------------|--------------|----------------|-----------------|
| M1 | lib/changes.js | Owns the turn-scoped change source and the file-tool path extraction. | - | M2, M3, M4 | ChangeTracker, readTurnChanges, mutationPath, contentKey |
| M2 | lib/tracker.js | Owns the per-session repository state, the tracked file set, and the item states. | M1, M5 | M3, M4 | RepositoryTracker, evaluateRepository, planAttest, attestSchemaErrors |
| M3 | lib/report.js | Owns the report and advisory text. | - | M1, M2, M4, M5, M6, M7, M8 | repositoriesMarkdown, advisoryMessage, oneLine |
| M4 | lib/index.js | Owns the service wiring, the event hook, the tool schema, and the system prompt. | M1, M2, M3, M5, M6, M7, M8 | - | CompletionGateService, apply |
| M5 | lib/repositories.js | Owns the repository root lookup. Existing, unchanged. | - | M1, M2, M3, M4, M6, M7, M8 | gitRootOf, owningRoot, absoluteOf |
| M6 | lib/catalog.js | Owns the verification catalog read and write. Existing, unchanged. | M5 | M1, M2, M3, M4, M7, M8 | readCatalog, registerItems |
| M7 | lib/core.js | Owns the pure configuration and scan helpers. Existing, unchanged. | - | M1, M2, M3, M4, M5, M6, M8 | resolveConfig, scanSecurity, addedLinesForRecord |
| M8 | lib/settings.js | Owns the saved settings file. Existing, unchanged. | M7 | M1, M2, M3, M4, M5, M6 | defaultSettingsPath, mergeSettings |

## Contracts

### C1: ChangeTracker records the file-tool paths of a turn

- kind: function
- owner: M1
- stability: provisional
- satisfies: R4, R5
- pre: `session.id` is a string, and `event` is a session event with `type` and `data`.
- post: A `tool/call` event stores a path under the event's turn only when `data.arguments` parses as JSON and the call matches the host's mutation predicates: `write` with a string `content` and a nonblank `file_path`; `edit` with string `old_string` and `new_string` and a nonblank `file_path`; `str_replace_editor` with `command` in `create`, `str_replace`, or `insert` and a nonblank `path`. A malformed argument string, an incomplete call, a rejected editor command, and an unrecognized tool store nothing. `data.arguments` is a raw JSON string, not an object. Every other event keeps its current behavior.
- errors: none; invalid JSON and unrecognized tool names are ignored.
- invariants: the stored path is the raw model-facing path, never resolved and never read; a turn's path set is kept until the session is forgotten.
- state: per-session `turns` and `fileToolPaths` maps; no disk state.

### C2: ChangeTracker.fileToolPaths returns the turn's absolute paths

- kind: function
- owner: M1
- stability: provisional
- satisfies: R4, R5
- pre: `turn` is an integer; `base` is the turn's record base or the session working directory.
- post: returns the turn's stored file-tool paths canonicalized like the host recorder: canonicalize the base first, then resolve each raw path against it, realpath the longest existing ancestor, append the missing suffix, then compare canonical absolute paths; sorted and without duplicates; an empty list when the turn stored none.
- errors: none.
- invariants: resolution follows the host's `canonicalPath(resolve(canonical(cwd), raw))`; only the existing ancestor is realpathed, and the path itself is not read as a file. The base is canonicalized before the raw path is resolved, because the host realpaths its working directory before it applies the path: a raw `link/..` names the parent of the link's target, while a lexical collapse would name the link's own parent.

### C3: RepositoryTracker.merge files only the intersection

- kind: function
- owner: M2
- stability: stable
- satisfies: R4, R5
- pre: `files` is the recorder's changed-file list for the turn; `fileToolPaths` is the absolute path set from C2; `base` is the recorder base; `fallback` is the session working directory.
- post: only a recorder file whose absolute path is in `fileToolPaths` is filed; every other file is ignored; the `(turn, seq)` idempotency key is unchanged; a file already filed keeps its claim.
- errors: a failed repository-root lookup throws before any file is filed, as today.
- invariants: a recorder file whose path no root-session file-tool call names is never filed; a path both sets name is filed even when another writer also changed it; the recorder is not changed. The guarantee is path overlap, not authorship: the host summary carries no author, so a same-path change by another writer is tracked.
- state: the tracker's per-session repository maps; the in-flight merge handling is unchanged.

### C4: evaluateRepository reports stated items and the unstated count

- kind: function
- owner: M2
- stability: stable
- satisfies: R1, R2, R3, R6
- pre: `snapshot` is one repository entry; `catalogState` is that repository's catalog read from disk.
- post: `items` contains the session's stated item states, including a stated item with a null state and an unrelated mark, each with the catalog name; `unstatedCount` is the number of catalog items with no session state; `problems` contains no catalog-item-not-stated problem for an unstated item; a stated item with a null state adds the assumed-without-a-reason problem, and this evaluator is the only place that adds it; the attestation problem is required only when the repository has changed files or stated items.
- errors: none.
- invariants: an absent item-state entry is unstated, while a present null entry is an assumed item with no reason; an unstated item never makes the repository unfinished; a repository with no changed files and only unstated items is complete; a stated item keeps its state; a reopen keeps the unrelated mark and clears the other states, as today.
- state: reads the snapshot; no mutation.

### C5: The report and the advisory render one summary line

- kind: function
- owner: M3
- stability: stable
- satisfies: R2, R6, R7
- pre: a repository evaluated by C4.
- post: when `unstatedCount > 0`, the status report prints the summary line `Unstated catalog items: N (history; no action required unless adopted).` before the full catalog reading list, then the stated items with their states, and the advisory prints the stated items except an unrelated one and the same summary line; when `unstatedCount` is zero, both outputs omit the line; the catalog section still lists every catalog item with its `proves` note after the summary.
- errors: none.
- invariants: no per-item line for an unstated item; the summary count equals the catalog items minus the stated items; the line is absent when the count is zero; the file, attestation, and problem sections keep their current shape.
- state: none.

### C6: repositoryReport passes the file-tool paths to the tracker

- kind: function
- owner: M4
- stability: stable
- satisfies: R4, R5
- pre: the session and its current turn; the host recorder read.
- post: for each turn, `tracker.merge` receives the turn's file-tool paths from C2 resolved against the turn's record base or the session working directory; the rest of the report is unchanged.
- errors: a failed turn read is named in `notices`, as today.
- invariants: the gate still reads the host recorder for the changed files and content keys; the recorder is not changed; a subagent session is still excluded from recording.
- state: none.

### C7: The system prompt says an unstated item is history

- kind: data shape
- owner: M4
- stability: stable
- satisfies: R1
- pre: the service starts and registers the system-prompt section.
- post: the section text says an item the session does not state is history, and it does not tell the model to mark an irrelevant item unrelated; the adopt, register, attest, and demonstrate instructions stay.
- errors: none.
- invariants: the section is registered once per service start; its name and order are unchanged.
- state: none.

## Data flow

A session event reaches `ChangeTracker.observe`. `turn/start` and `turn/end` keep their turn bookkeeping. `tool/call` stores a file path when the call matches the host's mutation predicates for `write`, `edit`, or `str_replace_editor`. `workspace/changes` stores the turn's sequence number. A status, attest, or stop read calls `repositoryReport`, which reads each turn's recorder summary, resolves the turn's file-tool paths, and calls `tracker.merge` with the intersection. `tracker.refresh` computes each filed file's content key, `evaluateRepository` reports the stated items and the unstated count, and `repositoriesMarkdown` or `advisoryMessage` renders the result.

## State and concurrency

All state is in memory per session; nothing is written to disk. The `tool/call` events of a turn arrive before the turn's `workspace/changes` event at turn end, so the file-tool path set is complete when the merge runs. The merge is idempotent per `(turn, seq)`. `attest` and `register` are serialized per session by `queued`; `repositoryReport` reads the tracker; `ChangeTracker.observe` is synchronous. A later status call sees the same file-tool set because `ChangeTracker` keeps it with the turn's sequence record.

## Brownfield delta

| Path | Existing fact | Proposed change | Evidence |
|------|---------------|-----------------|----------|
| lib/changes.js:122-144 | `ChangeTracker.observe` ignores `tool/call`; it records only the turn sequence and end. | Add file-tool path extraction and storage. | Read of the file; host `capture.ts:99-112`. |
| lib/tracker.js:39-57 | `fileTurn` files every recorder file. | File only the intersection with the file-tool paths. | Read of the file. |
| lib/tracker.js:357-376 | `evaluateRepository` pushes a not-stated problem for every catalog item with no state. | Report stated items and the unstated count; no not-stated problem. | Read of the file. |
| lib/report.js:11-19 | The status report lists every item. | List stated items and one summary line. | Read of the file. |
| lib/report.js:89-107 | The advisory lists every item except an unrelated one. | List stated items and one summary line. | Read of the file. |
| lib/index.js:484-541 | `repositoryReport` calls `merge` without file-tool paths. | Pass the turn's file-tool paths. | Read of the file. |
| lib/index.js:675-678 | The system prompt says to mark a catalog item unrelated. | Say an unstated item is history. | Read of the file. |
| tests/tracker.test.mjs:120-132 | Expects the not-stated problem. | Expect the summary line and no not-stated problem. | Read of the file. |
| tests/service.test.mjs:667-678 | Expects the not-stated problem. | Expect the summary line. | Read of the file. |
| tests/service.test.mjs:882-904 | Expects an emptied outer repository with a catalog item to be unfinished. | Expect complete when it has no files and no stated items. | Read of the file. |
| tests/gate-changes.test.mjs:82-89,120-134 | `announce` publishes no `tool/call`, yet the direct-edit test expects `src/feature.js` tracked. | Add a serialized `tool/call` for the `write`/`edit`/`str_replace_editor` fixture; keep a no-call fixture for shell-only and other-writer paths. | Read of the file; host `capture.ts:99-112`. |
| tests/tracker.test.mjs:62-68 | `announceTurn` publishes no `tool/call`. | Add a serialized `tool/call` for direct-edit fixtures. | Read of the file. |
| tests/service.test.mjs:276 | `announceTurn` publishes no `tool/call`. | Add a serialized `tool/call` for direct-edit fixtures. | Read of the file. |
| tests/stop-message.test.mjs:96-104 | `announce` publishes no `tool/call`. | Add a serialized `tool/call` for direct-edit fixtures. | Read of the file. |
| tests/message-source.test.mjs:72-79 | `announce` publishes no `tool/call`. | Add a serialized `tool/call` for direct-edit fixtures. | Read of the file. |
| tests/catalog.test.mjs:60-65 | `announceTurn` publishes no `tool/call`. | Add a serialized `tool/call` for direct-edit fixtures. | Read of the file. |
| tests/stop-message.test.mjs:331-357 | The advisory lists `smoke` as unfinished. | Expect the summary line and no per-item line for the unstated item; add a zero-count case that omits the line. | Read of the file. |

## Verification hooks

| Contract | Check | Command |
|----------|-------|---------|
| C1 | A `write`, `edit`, or `str_replace_editor` call stores its path; a malformed JSON, incomplete argument, rejected editor command, or `bash` call stores none. | `node --test tests/tracker.test.mjs` |
| C2 | A relative path resolves against the base; a relative symlink path and a missing leaf beneath it canonicalize to the host's path; a cwd containing `symlink/..` still overlaps the recorded path. | `node --test tests/tracker.test.mjs`, `node --test tests/service.test.mjs`, `node --test tests/gate-changes.test.mjs` |
| C3 | A recorder file not named by a file tool is not filed; a named file is filed. | `node --test tests/tracker.test.mjs` |
| C4 | One stated and one unstated item: the stated item is listed, the count is one, and no not-stated problem appears; an assumed item with no reason is exactly one problem. | `node --test tests/tracker.test.mjs` |
| C5 | The status and advisory show the summary line before the catalog list when the count is positive, omit it at zero, and show no per-item line for the unstated item; the catalog section keeps every item. | `node --test tests/tracker.test.mjs`, `node --test tests/service.test.mjs`, `node --test tests/stop-message.test.mjs` |
| C6 | A shell-command-only turn tracks no file; a turn with a `write` tracks it. | `node --test tests/service.test.mjs` |
| C7 | The system-prompt section says history and not mark-unrelated. | `node --test tests/service.test.mjs`, `node --test tests/package.test.mjs` |

## Traceability

| Requirement | Contracts | Tickets |
|-------------|-----------|---------|
| R1 | C4, C7 | T1, T3 |
| R2 | C4, C5 | T1 |
| R3 | C4 | T1 |
| R4 | C1, C2, C3, C6 | T2 |
| R5 | C1, C2, C3, C6 | T2 |
| R6 | C4, C5 | T1 |
| R7 | C5 | T1 |
| R8 | C1, C2, C3, C4, C5, C6 | T1, T2 |

## Uncertainties and tradeoffs

| Id | Uncertainty | Why unresolved | Settle by | Owner |
|----|-------------|----------------|-----------|-------|
| U1 | The `tool/call` event's `data.arguments` is a JSON string that the gate must parse. | The gate has no existing parser; the host's tests show the shape. | A test emits `arguments: JSON.stringify({ file_path: 'x', content: 'y' })` and asserts the path is stored. | Implementer |
| U2 | A file-tool path may be relative to the session working directory or absolute. | The event carries no working directory; the recorder's base is the summary working directory. | A test with a relative path and a base asserts the resolved absolute path. | Implementer |
| U3 | A `subagent` tool call is not a file tool and must be ignored. | The root's `tool/call` events include the `subagent` call. | A test emits `name: 'subagent'` and asserts no path is stored. | Implementer |
| U4 | The exact summary-line wording is not in the spec. | Resolved in review round 1: the wording is `Unstated catalog items: N (history; no action required unless adopted).` | reviews/01-review.md. | Document reviewer |
| U5 | A repository with only unstated catalog items and no files: complete or unfinished? | Resolved in review round 1: complete, because no changed file and no stated item leaves nothing to attest. | reviews/01-review.md. | Document reviewer |
| U6 | The assumed-without-a-reason problem is currently added by both `evaluateRepository` and `stagedAttest`. | Resolved in review round 1: the evaluator owns the single problem, and `stagedAttest` must not add it again. | reviews/01-review.md; an exact-one assertion. | Implementer |

## Revision log

| Date | Change | Trigger | Approved by |
|------|--------|---------|-------------|
| 2026-11-11 | Initial skeleton from the approved spec. | Spec commit 25b20ca. | Orchestrator |
| 2026-11-11 | Apply review round 1: C1 exact predicates, C2 host canonicalization, C3 path overlap, C4 U5/U6, C5 order and wording, C7 R1 only, T1/T2 test coverage. | reviews/01-review.md. | Orchestrator |
| 2026-11-11 | Apply review round 2: US5 and T2 title path overlap; C5 zero-count omission. | reviews/02-review.md. | Orchestrator |
| 2026-11-11 | Tier 1: C2 canonicalizes the base before resolving the raw tool path, after the final review reproduced a dropped overlap for a cwd containing `symlink/..` (C2 is provisional, so the change is notify-tier); T3's file list gains `tests/package.test.mjs` and the C2/C7 verification hooks name the tests that pin them. | reviews/05-review.md. | Orchestrator |
