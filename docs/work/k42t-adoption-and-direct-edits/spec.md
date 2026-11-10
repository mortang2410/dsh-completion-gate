# Spec: catalog items are adoption-only, and the gate tracks only direct file edits

Drafted 2026-11-11 from the grill-me decisions of the same day on kata issue k42t. Phase frozen at specification: no product code changed while writing it.

## Problem Statement

The completion gate treats every catalog item in a repository as an obligation of the current session. A repository's catalog is a history of checks that earlier sessions committed to run, so a session working in a shared workspace must dispose of every item from every earlier project before its own repository can read complete. On 2026-11-11 the catalog at `/home/wilder/.dsh/.dsh/verification.json` held 100 such items, and the gate demanded a state for each.

The gate also treats every file the host's change recorder lists for a turn as the session's own change. That list includes a file a shell command changed and a file another session or a subagent changed in the same repository during the turn, because the record carries no author. The session is then asked to claim work it did not do.

The owner's rule, from the grill board: only the items the session states, and only the files the session wrote with its own write or edit tool.

## Solution

An item obligates the session only when the session states it. An item the session does not state is history: the gate reports it as one line with a count, never as unfinished work. The catalog stays a reading list the session can adopt from, and the `unrelated` mark stays as an audit note but is no longer needed to silence history.

A file obligates the session only when the session wrote it with the `write`, `edit`, or `str_replace_editor` tool. A file a shell command changed, or another session or subagent changed, is not the session's obligation. The gate still detects changes automatically from the host recorder and the session's own tool calls; the model never declares what it changed.

## Directive Table

| The owner's decision | How he gave it | The resolved behavior in this design |
|---|---|---|
| "Only items the session states and the session directly edits." | Typed answer, first board, 2026-11-11 | An item counts only when the session states it; a file counts only when the session wrote it with a file tool. |
| The option "Only files the session wrote with the write or edit tool" | Picked on the second board, 2026-11-11 | The tracked file set is the intersection of the host recorder's changed files and the paths named by the session's `write`, `edit`, and `str_replace_editor` tool calls. |
| The option "One line with the count" | Picked on the first board, 2026-11-11 | The report shows stated items with their states and one summary line for the unstated items. |

The current code resolves these at:

- `lib/tracker.js:371` pushes a problem for every catalog item with no state.
- `lib/report.js:47-55` lists every catalog item in the status report.
- `lib/report.js:103-104` lists every item except an unrelated one in the stop advisory.
- `lib/tracker.js:39-57` files every changed file the recorder lists.
- `packages/deliverables/workspace-changes/src/capture.ts:99-112` maps the `write`, `edit`, and `str_replace_editor` tools to a path.
- `packages/deliverables/workspace-changes/src/types.ts:5-22` carries no author field on a changed file.
- `packages/deliverables/workspace-changes/src/index.ts:58-61` excludes subagent sessions from recording.

## User Stories

1. As the owner, I want a catalog item from an earlier project to stay silent until the current session states it, so a new session is not blocked by history.
2. As the owner, I want the report to show one line with the number of unstated items, so I know the catalog exists without reading 100 lines.
3. As the owner, I want a stated item to keep its state in the report, so I can see which checks the session ran or promised.
4. As the owner, I want an item the session states as assumed to stay visible as a promise, so I cannot mistake it for a pass.
5. As the owner, I want the gate to track a file the session wrote with the write or edit tool, so the session answers for its own changes.
6. As the owner, I want a file a shell command changed to stay out of the session's obligations, so the session is not asked about work it did not do directly.
7. As the owner, I want a file another session or a subagent changed to stay out of the session's obligations, so another writer's work is not blamed on this session.
8. As the owner, I want a file written with `str_replace_editor` to count the same as `write` or `edit`, so the rule does not depend on which file tool the model chose.
9. As the owner, I want the gate to keep detecting changes automatically, so the model never has to declare what it changed.
10. As the owner, I want a session that states nothing to go quiet on the catalog side, so a session that only reads or inspects a repository is not nagged.
11. As the owner, I want the `unrelated` mark to stay available as an audit note, so a session can record that it considered an item and found it irrelevant.
12. As a future session, I want the catalog to keep every item and its `proves` note, so I can read the history and adopt what fits.
13. As a reviewer, I want a test that fails when an unstated item is reported as unfinished, and a test that fails when a shell-command file is tracked, so the two rules are pinned.

## Implementation Decisions

- The catalog schema does not change. No scope field is added.
- The `unrelated` state stays in the tool contract and the report; it no longer has a silencing role because an unstated item is already silent.
- The gate's evaluation stops reporting an unstated item as a problem. It reports a stated item that is assumed without a reason, as today.
- The report lists the stated items with their states and one summary line naming the count of unstated items. The status report and the stop advisory use the same rule.
- The tracked file set is the intersection of the host recorder's changed files for the turn and the paths named by the session's file-tool calls. The gate reads the file-tool paths from the session's `tool/call` events, using the same tool-to-path mapping the host recorder uses.
- The file-tool paths are kept per turn for as long as the gate keeps that turn's change record, so a later status call sees the same set.
- A file a shell command changed, a file another session changed, and a file a subagent changed are not the session's obligations. The gate does not report them.
- The gate still reads the host recorder to detect changes and to compute each file's content key. The recorder is not changed.
- The gate's system-prompt paragraph stops telling the model to mark an irrelevant item unrelated. It says instead that an item the session does not state is history. The owner's instruction file already says to adopt the items that fit this work, so it needs no change.
- The existing catalogs need no migration. Their items become history under the new rule.

## Testing Decisions

- Test external behavior at the gate's repository report and the status action, not at the individual helper.
- A catalog with two items, one stated and one not, must report the stated item and one summary line for the unstated one, and must not report the unstated item as unfinished.
- A turn that writes a file with `write`, `edit`, or `str_replace_editor` must track that file.
- A turn whose only change is a shell command must not track that file.
- A turn whose only change is another session's or a subagent's write must not track that file.
- A stated item that is assumed without a reason stays unfinished, as today.
- The existing suite must keep passing, including the reopen, unrelated, and demonstration tests.
- The tests use the existing service seam and the existing fake recorder; no new seam is needed.

## Out of Scope

- A declared scope field on catalog items.
- Matching an item's command text to changed paths.
- Attributing a shell command's file change to the session.
- Attributing a subagent's or another session's file change to this session.
- Changing the host recorder.
- Cleaning or migrating existing catalogs.

## Further Notes

- The gate is advisory. It runs nothing and believes the model. This change narrows what it asks about; it does not add enforcement.
- The shell-command hole is accepted by the owner's answer: a file the session changes only through a shell command is not tracked. The gate's file check is therefore a check on the session's file-tool edits, not on every byte the turn changed.
- The `unrelated` state stays because it records a deliberate judgement. Removing it would be a separate contract change.
