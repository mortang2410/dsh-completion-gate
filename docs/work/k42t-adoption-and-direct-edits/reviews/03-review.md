# Review: revised spec, skeleton, and tickets T1-T3 for bug k42t (round 3)

- Date: 2026-11-11
- Mode: Third pre-implementation document review, after round-two fixes
- Repository: `/home/wilder/dsh-test/dsh-completion-gate`
- Feature: `k42t-adoption-and-direct-edits`
- Base/head: Gate HEAD [25b20ca](https://github.com/mortang2410/dsh-completion-gate/commit/25b20ca), full SHA `25b20cac6c00f62d24d006507cbd520d43342c38`; the review covers the uncommitted spec and skeleton. Product code and tests remain unchanged.
- Host source: [workspace-change recorder at `e24132af4f9eeea9218da00523e26e8450c3db35`](https://github.com/mortang2410/deepseek-harness/commit/e24132af4f9eeea9218da00523e26e8450c3db35), unchanged and clean for the cited paths.
- Scope: [round-one review](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/reviews/01-review.md>), [round-two review](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/reviews/02-review.md>), [spec](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md>), [skeleton](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md>), and current Kata records `dtmb`, `33zv` (T1), `nqce` (T2), and `jc2f` (T3). The Kata CLI returned no web URLs for these personal records.
- Threat model: The gate must not turn unstated catalog history into unfinished work or claim writer attribution that the host's path-only summary cannot prove. The spec, skeleton, and tickets must define one output rule.
- Rounds: 3
- Reviewer route: provider `codex`, model `codex/luna-bifrost`, reasoning effort `max`
- Publication: Report only; no comments were published to Kata.

T1 (`33zv`) owns catalog adoption and reporting, T2 (`nqce`) owns changed-path filtering, and T3 (`jc2f`) owns prompt wording. Path overlap means that the host summary and a recognized root-session file-tool call name the same path; it does not prove who wrote the bytes.

## Findings

No new findings.

## Dispositions

| Prior finding | Disposition | Evidence |
|---|---|---|
| Round 2 [P2] Align the user story and T2 title with path-overlap evidence | RESOLVED | US5 now states the path intersection and explicitly says the gate does not prove who wrote the bytes ([spec.md:43](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md#L43>)). T2 is titled “track changed paths that overlap root-session file-tool calls,” and its same-path acceptance case remains in Kata `personal#nqce`. |
| Round 2 [P2] Specify the zero-count summary-line behavior | RESOLVED | The spec conditions the line on a positive count and omits it at zero ([spec.md:40,58,69-70](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md#L40-L70>)); C5 and its hook state the same condition ([skeleton.md:14,91,93,158](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L14-L158>)); T1 adds the zero-count status and advisory criterion in Kata `personal#33zv`. |
| Round 1 [P1] T2 recorder-only test fixtures | RESOLVED | The skeleton lists all six affected fixtures and distinguishes direct-edit tool-call fixtures from shell-only and other-writer controls ([skeleton.md:142-147,154-156](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L142-L147>)); T2 `nqce` lists all six tests. |
| Round 1 [P2] T1 stop-advisory count test | RESOLVED | T1 includes the stop-message test and asserts a summary line with no per-item line for the unstated entry; C5 and its hook cover status and advisory output ([skeleton.md:91,148,158](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L91-L158>), Kata `personal#33zv`). |
| Round 1 [P2] C1 host mutation predicates | RESOLVED | C1 lists the host's `write`, `edit`, and `str_replace_editor` predicates and raw JSON argument shape ([skeleton.md:43-45](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L43-L45>)); the host predicate matches them ([capture.ts:99-112](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/capture.ts#L99-L112>)), and T2 covers malformed, incomplete, rejected, and accepted calls. |
| Round 1 [P2] C2 canonical path spelling | RESOLVED | C2 names host canonicalization and includes relative-symlink and missing-leaf checks ([skeleton.md:55-58,155](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L55-L58>)); the host resolves against `cwd` and canonicalizes the longest existing ancestor ([recorder.ts:156-165](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/recorder.ts#L156-L165>), [paths.ts:49-63](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/paths.ts#L49-L63>)). |
| Round 1 [P2] Bound authorship claims to path evidence | RESOLVED | The spec now makes the path-overlap limit explicit in the solution, US5, decisions, and further notes ([spec.md:17,43,61,90-91](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md#L17-L91>)); T2's title and same-path acceptance case state the same limit in Kata `personal#nqce`. |
| Round 1 [P2] Remove T2's behavior-independent T1 blocker | RESOLVED | T2 `nqce` has `Blocked by: None` and a shared-file coordination note; T3 `jc2f` remains blocked by T1 `33zv`. The skeleton maps R4/R5 to T2 ([skeleton.md:169-170](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L169-L170>)). |
| Round 1 [P2] Trace R2 to report contracts only | RESOLVED | C7 satisfies R1 only, and R2 maps to C4/C5 and T1 ([skeleton.md:108-115,167](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L108-L115>)). |
| Round 1 [P2] Put the C5 count before the full catalog list | RESOLVED | The spec and C5 require the summary before the full reading list; T1 and the verification hook cover that order ([spec.md:58](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md#L58>), [skeleton.md:91,158](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L91-L158>), Kata `personal#33zv`). |

## Review resolutions

- **U4, exact summary wording:** Resolved. The spec, C5, and T1 use `Unstated catalog items: N (history; no action required unless adopted).` ([spec.md:58](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md#L58>), [skeleton.md:91,182](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L91-L182>), Kata `personal#33zv`).
- **U5, only unstated items and no changed files:** Resolved as complete. T1 states the case explicitly, and C4 records the same invariant ([skeleton.md:79-81,183](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L79-L81>), Kata `personal#33zv`).
- **U6, reasonless assumed item:** The planned contract assigns one reason-specific problem to `evaluateRepository`, and T1 requires exactly one problem ([skeleton.md:79-81,184](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L79-L81>), Kata `personal#33zv`). At current HEAD, `evaluateRepository` adds a generic `Catalog item not stated` problem for a null state, while `stagedAttest` adds a different reason-specific problem ([tracker.js:369-373](</home/wilder/dsh-test/dsh-completion-gate/lib/tracker.js#L369-L373>), [index.js:313-316](</home/wilder/dsh-test/dsh-completion-gate/lib/index.js#L313-L316>)). The proposed design consolidates these into one evaluator-owned reason-specific problem; the existing service test still uses `.some` and does not assert exact cardinality ([service.test.mjs:802-822](</home/wilder/dsh-test/dsh-completion-gate/tests/service.test.mjs#L802-L822>)). This is implementation work, not an unresolved document decision.
- **Old assertions:** The current tracker and service tests still expect `Catalog item not stated`, and the nested-repository test still expects the emptied outer repository to be unfinished ([tracker.test.mjs:120-132](</home/wilder/dsh-test/dsh-completion-gate/tests/tracker.test.mjs#L120-L132>), [service.test.mjs:667-678](</home/wilder/dsh-test/dsh-completion-gate/tests/service.test.mjs#L667-L678>), [service.test.mjs:882-904](</home/wilder/dsh-test/dsh-completion-gate/tests/service.test.mjs#L882-L904>)). T1 acceptance criteria assign the replacements; the tests remain unchanged because the feature is not implemented.
- **Unrelated mark:** The tracker preserves an unrelated mark on reopen, the status report lists the state, and the advisory omits it ([tracker.js:126-145](</home/wilder/dsh-test/dsh-completion-gate/lib/tracker.js#L126-L145>), [report.js:11-17](</home/wilder/dsh-test/dsh-completion-gate/lib/report.js#L11-L17>), [report.js:101-105](</home/wilder/dsh-test/dsh-completion-gate/lib/report.js#L101-L105>)). C4 retains that distinction ([skeleton.md:79-81](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L79-L81>)).
- **C7 prompt:** T3 still owns the history wording and retention of adopt/register/attest/demonstrate guidance. The live prompt still has the old unrelated-mark instruction because no product code changed ([skeleton.md:108-117](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L108-L117>), [index.js:675-678](</home/wilder/dsh-test/dsh-completion-gate/lib/index.js#L675-L678>), Kata `personal#jc2f`).

## Possible concerns

None beyond the implementation verification gap below.

## Verification

The revised skeleton lint passed in round three. The gate source and test files remain unchanged, so this review did not rerun `npm test`; the 277/277 result from round one remains a pre-implementation baseline only. The gate commands ran from `/home/wilder/dsh-test/dsh-completion-gate`, and the host Git command ran from `/home/wilder/git-repos/deepseek-harness-020`.

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
$ ulimit -v 4194304; timeout --kill-after=5s 240s npm test
1..277
# tests 277
# pass 277
# fail 0
# duration_ms 909.176528
exit code: 0 (measured in round one at unchanged code HEAD; not rerun in round three)
```

```text
$ git check-ignore -v /home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/reviews/03-review.md
(no output; exit code 1 before report creation, so the destination is not ignored)
$ git rev-parse HEAD && git status --short -- packages/deliverables/workspace-changes/src/capture.ts packages/deliverables/workspace-changes/src/types.ts packages/deliverables/workspace-changes/src/index.ts packages/deliverables/workspace-changes/src/recorder.ts packages/deliverables/workspace-changes/src/paths.ts packages/core/agent-loop/src/tool-calls.ts packages/llm/llm/src/types.ts packages/core/agent-loop/tests/coverage-edges.spec.ts packages/subagent/subagent/lib/index.js
 e24132af4f9eeea9218da00523e26e8450c3db35
(no output)
$ kata --project personal show 33zv
$ kata --project personal show nqce
$ kata --project personal show jc2f
$ kata --project personal show dtmb
exit code: 0 for each; all four records are open; T2 is unblocked and T3 remains blocked by T1.
```

```text
$ git status --short --untracked-files=all && git branch --show-current && git rev-parse HEAD
 M docs/work/k42t-adoption-and-direct-edits/spec.md
?? docs/work/k42t-adoption-and-direct-edits/reviews/01-review.md
?? docs/work/k42t-adoption-and-direct-edits/reviews/02-review.md
?? docs/work/k42t-adoption-and-direct-edits/reviews/03-review.md
?? docs/work/k42t-adoption-and-direct-edits/skeleton.md
main
25b20cac6c00f62d24d006507cbd520d43342c38
```

The round-two report records the prior isolated drift mismatch: planned `M1:mutationPath` is absent at this pre-implementation HEAD. Its combined round-two lint/drift job output was unavailable, so this report does not assign that job's exit code to either subcommand. The separate round-three skeleton lint passed.

## Unverified risks

- The feature has no implementation at HEAD. The 277 passing tests are a pre-change baseline, not evidence that the planned behavior works.
- The host summary contains no author field, so the accepted same-path overlap rule cannot prove who wrote the bytes.
- The exact-one reasonless-assumed behavior and the zero-count output are documented, but neither behavior is implemented or exercised by the current code.

## Verdict

The two round-two findings are resolved, all eight round-one findings are resolved, and U4/U5/U6 remain settled. No new document finding blocks implementation.

VERDICT: APPROVE
