# Review: spec dtmb and tickets T1-T3 for bug k42t

This review checks two planned behaviors. “Catalog adoption only” means a catalog item creates an obligation only when the current Completion Gate session states that item; an unstated item is history, not unfinished work. “Direct-file evidence” means a changed path is tracked only when both the host's turn summary and the current Completion Gate session's recognized file-tool call name that path. That path intersection is evidence of overlap, not proof that the current session caused the bytes if another writer changed the same path.

- Date: 2026-11-11
- Mode: First pre-implementation review of a spec and its three implementation tickets
- Gate repository: `/home/wilder/dsh-test/dsh-completion-gate`
- Feature: `k42t-adoption-and-direct-edits`, the feature directory and slug
- Gate base = head: `25b20cac6c00f62d24d006507cbd520d43342c38`; the spec is committed at this same revision, which is also current HEAD
- Host source repository: `/home/wilder/git-repos/deepseek-harness-020`, revision [`e24132af4f9eeea9218da00523e26e8450c3db35`](https://github.com/mortang2410/deepseek-harness/commit/e24132af4f9eeea9218da00523e26e8450c3db35)
- Scope: Kata records `dtmb`, `33zv`, `nqce`, `jc2f`, and `k42t`; the [spec](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md>), [skeleton](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md>), and [outline baseline](</home/wilder/Trash/k42t-skeleton/outline-before.json>); gate source and tests listed below; DSH host source listed below. Read each cited source when checking the finding that cites it.
- Threat model: The old gate reports every unstated catalog item as unfinished and files every changed path in the host summary. The review checks whether the proposed rules omit direct file edits, blame another writer, or leave implementation tests preserving the old behavior.
- Reviewer route: provider `codex`, model `codex/luna-bifrost`, reasoning effort `max`
- Cold-reader route: provider `codex`, model `codex/luna-bifrost`, reasoning effort `max`
- Review rounds: 1, the first review file for this feature
- Publication: I wrote this report only; I published no comment to a Kata record and made no commit.

## Record map and terms

Kata is the local issue tracker. Project `personal` is the project key; the command `kata --project personal show <id>` reads one record. Record `dtmb` is the parent spec, record `33zv` is T1 (catalog adoption and reporting), record `nqce` is T2 (direct-file path tracking), record `jc2f` is T3 (system-prompt wording), and record `k42t` is the related bug. These five records were open when I reviewed them. The Kata CLI output supplied no web URLs for these records.

T1, T2, and T3 name those ticket roles throughout this report. P1 means a gap likely to break or invalidate the feature's implementation tests. P2 means an important specification, acceptance, or dependency gap that needs correction before implementation.

The “root session” is the current Completion Gate session, not a delegated child session. The “host summary” is the DSH workspace-change recorder's per-turn list of changed paths. A “file-tool path” is a path extracted from a root-session `tool/call` event. A “recorder-only fixture” is a test helper that publishes a host summary without publishing a root-session `tool/call` event. A “direct-file path” in the skeleton's proposed C3 contract is a path present in both sets.

The “status report” is the Completion Gate status action's repository text, rendered by `repositoriesMarkdown`. The “stop advisory” is the message emitted by `advisoryMessage` when a turn stops. “Quiet on catalog obligations” means an unstated item creates no item-specific problem; the one-line history count may still appear.

Skeleton labels mean: C1 captures file-tool paths; C2 normalizes paths; C3 filters changed files by path intersection; C4 evaluates catalog states; C5 renders status and advisory text; C6 wires paths into the tracker; C7 changes the system prompt. R1 is the rule that only stated items obligate the session; R2 is the one-line count for unstated items. US2 asks for a count line, US10 asks the gate not to nag a session for unstated items, and US12 requires the status report's catalog reading list to keep every item and its `proves` note. U5 asks whether a repository with only unstated items and no changed files is complete or unfinished. U6 asks how to avoid duplicating the reasonless-assumed problem. M1 is the skeleton's planned `lib/changes.js` module; `M1:mutationPath` is a planned gate helper absent at current HEAD. The host recorder also has a different function named `mutationPath` in its own `capture.ts` file.

The skeleton's “Brownfield delta” section is its existing-code change table. The status report must keep the full catalog reading list as material a future session can adopt from; the list is required in that report, while adopting any unstated entry is optional.

## Evidence sources

The gate source files are [lib/changes.js](</home/wilder/dsh-test/dsh-completion-gate/lib/changes.js>), [lib/tracker.js](</home/wilder/dsh-test/dsh-completion-gate/lib/tracker.js>), [lib/report.js](</home/wilder/dsh-test/dsh-completion-gate/lib/report.js>), [lib/index.js](</home/wilder/dsh-test/dsh-completion-gate/lib/index.js>), and [lib/repositories.js](</home/wilder/dsh-test/dsh-completion-gate/lib/repositories.js>). The gate tests are [tests/gate-changes.test.mjs](</home/wilder/dsh-test/dsh-completion-gate/tests/gate-changes.test.mjs>), [tests/tracker.test.mjs](</home/wilder/dsh-test/dsh-completion-gate/tests/tracker.test.mjs>), [tests/service.test.mjs](</home/wilder/dsh-test/dsh-completion-gate/tests/service.test.mjs>), [tests/stop-message.test.mjs](</home/wilder/dsh-test/dsh-completion-gate/tests/stop-message.test.mjs>), [tests/message-source.test.mjs](</home/wilder/dsh-test/dsh-completion-gate/tests/message-source.test.mjs>), and [tests/catalog.test.mjs](</home/wilder/dsh-test/dsh-completion-gate/tests/catalog.test.mjs>). The cited files provide the current gate behavior and fixture shapes.

The host source files are [workspace-changes capture.ts](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/capture.ts>), [workspace-changes types.ts](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/types.ts>), [workspace-changes index.ts](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/index.ts>), [workspace-changes recorder.ts](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/recorder.ts>), [workspace-changes paths.ts](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/paths.ts>), [agent-loop tool-calls.ts](</home/wilder/git-repos/deepseek-harness-020/packages/core/agent-loop/src/tool-calls.ts>), [LLM types.ts](</home/wilder/git-repos/deepseek-harness-020/packages/llm/llm/src/types.ts>), [agent-loop coverage-edges.spec.ts](</home/wilder/git-repos/deepseek-harness-020/packages/core/agent-loop/tests/coverage-edges.spec.ts>), and [subagent index.js](</home/wilder/git-repos/deepseek-harness-020/packages/subagent/subagent/lib/index.js>). Read each file at the finding that cites it. The host source is at the revision named in the header, and the cited host paths were clean in that checkout.

## Findings

### [P1] T2 must add root file-tool events to direct-edit fixtures - [gate-changes.test.mjs:80-90,120-132](</home/wilder/dsh-test/dsh-completion-gate/tests/gate-changes.test.mjs#L80-L132>)

Fault: The `announce` helper publishes turn-start, user-message, and workspace-change events plus a changed-file summary, but it never publishes a root-session `tool/call`. The test “a turn the recorder reported changes for is attributed to the session” nevertheless expects `src/feature.js` to be tracked. The same recorder-only helper shape appears in [tracker.test.mjs:61-68](</home/wilder/dsh-test/dsh-completion-gate/tests/tracker.test.mjs#L61-L68>), [service.test.mjs:274-276](</home/wilder/dsh-test/dsh-completion-gate/tests/service.test.mjs#L274-L276>), [stop-message.test.mjs:95-103](</home/wilder/dsh-test/dsh-completion-gate/tests/stop-message.test.mjs#L95-L103>), [message-source.test.mjs:72-79](</home/wilder/dsh-test/dsh-completion-gate/tests/message-source.test.mjs#L72-L79>), and [catalog.test.mjs:59-65](</home/wilder/dsh-test/dsh-completion-gate/tests/catalog.test.mjs#L59-L65>). T2 record `nqce` lists only `tracker.test.mjs` and `service.test.mjs` as test deliverables.

Why: When the implementation follows C3 and filters host paths through root-session file-tool paths, each recorder-only fixture has an empty file-tool path set. A fixture that intends to represent a direct file edit will then fail or stop exercising that behavior.

Fix: Ticket T2 (`nqce`) must list the affected tests and add a serialized `tool/call` event only to fixtures that represent a root-session `write`, `edit`, or mutating `str_replace_editor` call. T2 must keep explicit no-call fixtures for shell-only and other-writer paths. The T2 acceptance test and C1/C3 hooks must pass along with `npm test` after implementation.

### [P2] T1 must test the unstated-item count in stop advisories - [stop-message.test.mjs:331-357](</home/wilder/dsh-test/dsh-completion-gate/tests/stop-message.test.mjs#L331-L357>)

Fault: The test catalog contains `unit`, `browser`, and `smoke`. The test states `unit` as passed and `browser` as assumed with a reason; `smoke` is unstated, and the current assertion expects `smoke` as unfinished. Spec [spec.md:58](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md#L58>) requires the status report and stop advisory to use the same adoption rule. Skeleton [C5 at skeleton.md:91](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L91>) requires one count line in each output, but the existing-code change table at [skeleton.md:139-141](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L139-L141>) and T1 record `33zv` omit this advisory regression. Current advisory rendering filters unrelated entries but lists each remaining catalog item at [report.js:101-105](</home/wilder/dsh-test/dsh-completion-gate/lib/report.js#L101-L105>).

Why: T1 can pass its listed tracker and service tests while the stop advisory still reports `smoke` as unfinished or omits the count line.

Fix: Ticket T1 (`33zv`) must add `tests/stop-message.test.mjs` to its deliverables and acceptance criteria; the skeleton's C5 hook and existing-code change table must include it. The test must keep `unit` and `browser`, omit a per-item `smoke` line, and assert a one-item history line such as `Unstated catalog items: 1 (history; no action required unless adopted).` The test must pass with `node --test tests/stop-message.test.mjs` after implementation.

### [P2] C1 must match the host's exact mutation predicates - [skeleton.md:44](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L44>)

Fault: C1 records a path whenever a tool name and parsed arguments “name a file path.” The host recorder accepts `write` only when `content` is a string and `file_path` is nonblank; it accepts `edit` only when `old_string` and `new_string` are strings and `file_path` is nonblank; it accepts `str_replace_editor` only for `create`, `str_replace`, or `insert` with a nonblank `path` ([host capture.ts:86-112](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/capture.ts#L86-L112>)).

Why: A broad mapping could treat an unsupported editor command or incomplete call as a file mutation. The root-session `tool/call` event stores `data.arguments` as a raw JSON string, not an object ([LLM types.ts:104-112](</home/wilder/git-repos/deepseek-harness-020/packages/llm/llm/src/types.ts#L104-L112>), [agent-loop tool-calls.ts:262-265](</home/wilder/git-repos/deepseek-harness-020/packages/core/agent-loop/src/tool-calls.ts#L262-L265>), and the event-shape test at [coverage-edges.spec.ts:78-83](</home/wilder/git-repos/deepseek-harness-020/packages/core/agent-loop/tests/coverage-edges.spec.ts#L78-L83>)).

Fix: Ticket T2 (`nqce`) must define C1's JSON parse and tool mapping with the exact host predicates above. T2's tests must cover each accepted call, malformed JSON, incomplete arguments, and rejected editor commands; `node --test tests/tracker.test.mjs` must pass after implementation.

### [P2] C2 must normalize paths like the host recorder - [skeleton.md:56-58](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L56-L58>)

Fault: C2 resolves an event path with `path.resolve(base, raw)` and claims that the result matches the host summary. The host recorder resolves a file-tool path with `canonicalPath(resolve(paths.cwd, path))`; `canonicalPath` resolves the longest existing ancestor with `realpath` and appends missing path components ([host recorder.ts:156-166](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/recorder.ts#L156-L166>), [host paths.ts:49-63](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/paths.ts#L49-L63>)). The host summary stores a canonical path relative to session `cwd`, or an absolute path outside `cwd` ([host paths.ts:91-98](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/paths.ts#L91-L98>)).

Why: `path.resolve` does not follow a symlink ancestor. A call through a directory symlink can therefore produce an alias in C2 while the host summary reports the symlink target, so C3 misses a real path intersection.

Fix: Ticket T2 (`nqce`) must specify the host algorithm: resolve from session `cwd`, realpath the longest existing ancestor, append any missing suffix, then compare canonical absolute paths. T2 must add a service-seam test for a relative symlink path and a missing leaf beneath that symlink; `node --test tests/service.test.mjs` must pass after implementation.

### [P2] The spec and T2 must limit authorship claims to path evidence - [spec.md:17,61](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md#L17-L61>); Kata record `nqce`

Fault: Spec [lines 17 and 61](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md#L17-L61>) and T2 record `nqce` claim that another session's or subagent's changed file is never this session's obligation. The C3 algorithm instead intersects changed paths with root-session tool-call paths.

Why: The host's `WorkspaceChangedFile` contains path, display, line counts, and optional binary/oversized flags, but no author, session id, or delegation marker ([host types.ts:4-22](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/types.ts#L4-L22>)). The host recorder snapshots and diffs the whole workspace ([host recorder.ts:303-368](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/recorder.ts#L303-L368>)); the host excludes child sessions from their own recording ([host index.ts:58-61](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/index.ts#L58-L61>)), while an in-process child inherits its parent's `cwd` ([subagent index.js:470-480](</home/wilder/git-repos/deepseek-harness-020/packages/subagent/subagent/lib/index.js#L470-L480>)). A root `tool/call` event is appended before its result, including for a call later aborted before dispatch ([agent-loop tool-calls.ts:250-265](</home/wilder/git-repos/deepseek-harness-020/packages/core/agent-loop/src/tool-calls.ts#L250-L265>)). Thus a failed or no-op root call naming path X and a different writer changing path X can put X in both sets, even though the gate cannot prove which writer caused the bytes.

Fix: The spec and T2 (`nqce`) must define the guarantee as path overlap: the gate tracks a path only when the host summary and a root-session mutating file-tool call both name it. They must narrow “another writer's file is excluded” to a path with no matching root-session file-tool call and document the same-path authorship ceiling. The spec's out-of-scope section already excludes a host-recorder change, so this fix should narrow the wording rather than promise author detection. T2 must test that a different-path other-writer change is excluded.

### [P2] T2 must not depend on T1's catalog evaluator - Kata record `nqce`, “Blocked by” section

Fault: T2 record `nqce` says T2 is blocked by T1 because both tickets touch `lib/tracker.js`. T2 adds file-tool path capture and filters the host summary. Those operations do not depend on T1's catalog evaluation or summary rendering. T3 record `jc2f` changes prompt text to describe the implemented adoption rule and does depend on T1.

Fix: The issue owner must remove T1 from T2's “Blocked by” field and keep a shared-file integration note for `lib/tracker.js`. T3 (`jc2f`) should remain blocked by T1 (`33zv`).

### [P2] The skeleton must trace R2 to report contracts only - [skeleton.md:113,160](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L113-L160>)

Fault: C7 changes the system-prompt text, but C7 claims R2 and the R2 traceability row assigns C7 and T3. R2 is the report's stated-item and unstated-count output rule, not prompt wording.

Fix: The skeleton author must make C7 satisfy R1 only. The skeleton author must map R2 to C4 and C5 and T1 (`33zv`). T1's tracker, service, and stop-message tests must assert the summary output.

### [P2] C5 must put the count before the full catalog reading list - [skeleton.md:91](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L91>)

Fault: C5 requires the catalog section to list every item and its `proves` note but does not order that list against the summary. Current `repositoriesMarkdown` prints `catalogLines` before the item-state lines ([report.js:11-15](</home/wilder/dsh-test/dsh-completion-gate/lib/report.js#L11-L15>), [report.js:45-55](</home/wilder/dsh-test/dsh-completion-gate/lib/report.js#L45-L55>)).

Why: If the implementation keeps that order, a reader must pass the full history list before seeing the count requested by US2. US12 still requires the full list for future adoption; the list is required in the report but optional for a reader to act on.

Fix: The skeleton author must require the summary line before the full catalog reading list in C5 and its verification hook. The summary should state that unstated items are history and need no action unless adopted; the status report must keep every catalog item and `proves` note.

## Review resolutions

- I found an owner for every user story and each ticket acceptance criterion. T1 (`33zv`) owns catalog adoption and report behavior; T2 (`nqce`) owns file-tool path tracking; T3 (`jc2f`) owns system-prompt wording. The T2 dependency is the exception to the otherwise consistent issue links.
- The existing assertion at [tracker.test.mjs:120-132](</home/wilder/dsh-test/dsh-completion-gate/tests/tracker.test.mjs#L120-L132>) and the assertion at [service.test.mjs:667-678](</home/wilder/dsh-test/dsh-completion-gate/tests/service.test.mjs#L667-L678>) should stop expecting an unstated-item problem. The test at [service.test.mjs:882-904](</home/wilder/dsh-test/dsh-completion-gate/tests/service.test.mjs#L882-L904>) should expect the test's temporary outer repository to read complete after its only changed file moves into the nested test repository and no item is stated. T1 acceptance criteria explicitly require complete in that case.
- U5 asks whether a repository with no changed files and only unstated catalog items is complete or unfinished. T1 record `33zv` explicitly says that repository can read complete, so the review resolves U5 as complete without attributing a new decision to the user.
- U6 is consistent if the evaluator distinguishes no item-state entry from an entry whose state is null. An absent entry is unstated; a present null entry represents an assumed item with no reason. The evaluator should own the single reasonless-assumed problem, and `stagedAttest` should not add it again. The existing test at [service.test.mjs:802-822](</home/wilder/dsh-test/dsh-completion-gate/tests/service.test.mjs#L802-L822>) checks that one problem exists with `.some`; the implementer should add an exact-one assertion.
- The current tracker preserves an `unrelated` mark when a repository reopens ([tracker.js:122-145](</home/wilder/dsh-test/dsh-completion-gate/lib/tracker.js#L122-L145>)). The current status report lists that mark while the current stop advisory omits it ([report.js:101-105](</home/wilder/dsh-test/dsh-completion-gate/lib/report.js#L101-L105>)). The spec's requirement to preserve this distinction is consistent.
- The spec's C7 prompt change removes the instruction to mark history unrelated while retaining adopt, register, attest, and demonstrate instructions. T3 record `jc2f` covers that prompt change and its service test.
- The Kata CLI showed `dtmb` as parent of `33zv`, `nqce`, and `jc2f`, with `k42t` related to `dtmb`; all five records were open. The published spec points to commit [`25b20ca`](https://github.com/mortang2410/dsh-completion-gate/commit/25b20ca), which matches the gate repository's current HEAD. I use the spec and Kata comments as stored records, not as new direct quotations from the user.

## Verification

All commands below ran from `/home/wilder/dsh-test/dsh-completion-gate` unless a command names another root. The gate suite and skeleton checks ran against gate HEAD `25b20ca`; the feature is not implemented at that revision.

```text
$ kata --project personal show dtmb
$ kata --project personal show 33zv
$ kata --project personal show nqce
$ kata --project personal show jc2f
$ kata --project personal show k42t
All five records returned exit code 0. All five were open. Record dtmb named children 33zv, nqce, and jc2f; record k42t was related to dtmb; T1 blocked T2 and T3.
```

```text
$ ulimit -v 4194304; timeout --kill-after=5s 240s npm test
1..277
# tests 277
# pass 277
# fail 0
# duration_ms 909.176528
exit code: 0
```

```text
$ export SKILL_DIR=/home/wilder/git-repos/dotfiles/.dsh/skills/post-spec-skeleton; ulimit -v 4194304; timeout --kill-after=5s 60s python3 "$SKILL_DIR/scripts/skeleton_lint.py" docs/work/k42t-adoption-and-direct-edits/skeleton.md
requirements: 8
modules: 8
contracts: 7
stable: 5
provisional: 2
uncertainties: 6
traceability_rows: 8
verification_hooks: 7
status: OK
exit code: 0
```

```text
$ export SKILL_DIR=/home/wilder/git-repos/dotfiles/.dsh/skills/post-spec-skeleton; ulimit -v 4194304; timeout --kill-after=5s 60s python3 "$SKILL_DIR/scripts/drift_check.py" docs/work/k42t-adoption-and-direct-edits/skeleton.md --root . --baseline /home/wilder/Trash/k42t-skeleton/outline-before.json
modules: 8/8 present
error: declared public symbol missing from code: M1:mutationPath
status: FAIL
exit code: 1
```

The drift command also emitted warnings for unapproved existing symbols and support modules absent from the four-module outline baseline. The skeleton lists eight modules, including the planned `M1:mutationPath`; the gate source at HEAD does not implement that helper. The drift failure is the expected pre-implementation mismatch, not a `skeleton_lint.py` failure.

```text
$ git -C /home/wilder/dsh-test/dsh-completion-gate rev-parse HEAD
25b20cac6c00f62d24d006507cbd520d43342c38
$ git -C /home/wilder/dsh-test/dsh-completion-gate status --short
?? docs/work/k42t-adoption-and-direct-edits/skeleton.md
$ git -C /home/wilder/dsh-test/dsh-completion-gate check-ignore -v /home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/reviews/01-review.md
(no rule printed; exit code 1, so the report path is not ignored)
$ git -C /home/wilder/git-repos/deepseek-harness-020 rev-parse HEAD
e24132af4f9eeea9218da00523e26e8450c3db35
$ git -C /home/wilder/git-repos/deepseek-harness-020 status --short -- packages/deliverables/workspace-changes/src/capture.ts packages/deliverables/workspace-changes/src/types.ts packages/deliverables/workspace-changes/src/index.ts packages/deliverables/workspace-changes/src/recorder.ts packages/deliverables/workspace-changes/src/paths.ts packages/core/agent-loop/src/tool-calls.ts packages/llm/llm/src/types.ts packages/core/agent-loop/tests/coverage-edges.spec.ts packages/subagent/subagent/lib/index.js
(no output; the cited host files were clean)
```

## Unverified risks

- No feature implementation exists at gate HEAD `25b20ca`. The 277 passing tests are the pre-change baseline and do not verify the proposed behavior.
- I did not run a symlink-path probe. The mismatch follows from the two inspected implementations: the host resolves symlink ancestors while skeleton C2 uses `path.resolve` only.
- I did not run a same-path concurrent-writer probe. The host summary has no author field, so the path intersection cannot resolve that case without recorder-level author evidence.

## Verdict

The spec and tickets need changes before implementation because the path-filter tests omit tool-call evidence, the advisory test omits the history count, and the mutation and attribution contracts overstate what the host records can prove.

VERDICT: CHANGES
