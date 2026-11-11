# Review: revised spec, skeleton, and tickets T1-T3 for bug k42t (round 2)

- Date: 2026-11-11
- Mode: Round-two pre-implementation document review
- Repository: `/home/wilder/dsh-test/dsh-completion-gate`
- Feature: `k42t-adoption-and-direct-edits`
- Base/head: Gate HEAD [25b20ca](https://github.com/mortang2410/dsh-completion-gate/commit/25b20ca), full SHA `25b20cac6c00f62d24d006507cbd520d43342c38`; the review covers the uncommitted spec and skeleton changes. Product code and tests remain unchanged.
- Host source: [workspace-change recorder at `e24132af4f9eeea9218da00523e26e8450c3db35`](https://github.com/mortang2410/deepseek-harness/commit/e24132af4f9eeea9218da00523e26e8450c3db35), unchanged and clean for the cited paths.
- Scope: [round-one review](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/reviews/01-review.md>), [spec](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md>), [skeleton](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md>), current Kata records `dtmb`, `33zv` (T1), `nqce` (T2), and `jc2f` (T3), and the gate and host source/tests cited below. The Kata CLI returned no web URLs for these personal records.
- Threat model: The design must not turn unstated catalog history into unfinished work or claim writer attribution that the host's path-only summary cannot prove. The spec, skeleton, and tickets must give implementers one observable output rule.
- Rounds: 2
- Reviewer route: provider `codex`, model `codex/luna-bifrost`, reasoning effort `max`
- Publication: Report only; no comments were published to Kata.

T1 (`33zv`) owns catalog adoption and reporting, T2 (`nqce`) owns file-path filtering, and T3 (`jc2f`) owns prompt wording. The host summary is the recorder's per-turn list of changed paths; a root-session file-tool call is a `tool/call` event from the current session.

## Findings

### [P2] Align the user story and T2 title with path-overlap evidence - [spec.md:43](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md#L43>); Kata `personal#nqce` title

Fault: Spec US5 says, “As the owner, I want the gate to track a file the session wrote with the write or edit tool, so the session answers for its own changes.” T2 is still titled “track only files the session wrote with a file tool.” The spec and T2 body now say the gate tracks path overlap and includes a same-path change by another writer ([spec.md:17,61,90](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md#L17-L90>); Kata `personal#nqce`, “What to build” and acceptance criteria). The host record has no author field ([types.ts:5-22](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/types.ts#L5-L22>)), and the host appends a `tool/call` before its result ([tool-calls.ts:262-265](</home/wilder/git-repos/deepseek-harness-020/packages/core/agent-loop/src/tool-calls.ts#L262-L265>)).

Why: A same-path change by another writer can satisfy both sets without proving that the current session wrote the bytes. The remaining story and title still promise authorship and could lead a builder to treat a tool-call path as proof of causation.

Fix: Rewrite US5 to say, “The gate tracks a changed path only when the host summary and a recognized mutating file-tool call in the root session name the same path; this is path overlap, not proof of who wrote the bytes.” Rename T2 to “track changed paths that overlap root-session file-tool calls.” Keep the explicit same-path acceptance case in T2.

### [P2] Specify the zero-count summary-line behavior - [spec.md:40,58,69](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md#L40-L69>); [skeleton.md:91](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L91>); Kata `personal#33zv`

Fault: The spec and T1 describe one summary line without a condition. C5 says the status report prints it only when `unstatedCount > 0`. Neither T1's acceptance criteria nor its verification hooks decide what the report does when every catalog item is stated.

Why: A catalog with zero unstated items can produce either a visible `0` line under the spec's unqualified wording or no line under C5. Two implementations could therefore emit different output at zero, and the acceptance tests do not decide which output is required.

Fix: Keep C5's behavior, add “when `unstatedCount > 0`” to the spec and T1, and add status-report and advisory assertions that omit the line at zero. The positive-count assertion should continue to require the exact history wording.

## Review resolutions

- **U4, exact wording:** Resolved. The spec and T1 give `Unstated catalog items: N (history; no action required unless adopted).` and C5 uses that wording ([spec.md:58](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md#L58>), [skeleton.md:91,182](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L91-L182>), Kata `personal#33zv`, acceptance criteria).
- **U5, no files and only unstated items:** Resolved as complete. T1 says this explicitly, and C4 records the same invariant ([skeleton.md:79-81,183](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L79-L81>), Kata `personal#33zv`, “What to build” and acceptance criteria).
- **U6, one reasonless-assumed problem:** The planned contract is clear: C4 makes the evaluator the sole owner, and T1 requires exactly one problem ([skeleton.md:79-81,184](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L79-L81>), Kata `personal#33zv`, acceptance criteria). At current HEAD, `evaluateRepository` adds the generic `Catalog item not stated` problem for a null item state, while `stagedAttest` adds a different, reason-specific problem ([tracker.js:369-373](</home/wilder/dsh-test/dsh-completion-gate/lib/tracker.js#L369-L373>), [index.js:313-316](</home/wilder/dsh-test/dsh-completion-gate/lib/index.js#L313-L316>)). The revised contract should replace those two outputs with one evaluator-owned reason-specific problem; the current service test still checks only `.some` and does not pin the exact count ([service.test.mjs:802-822](</home/wilder/dsh-test/dsh-completion-gate/tests/service.test.mjs#L802-L822>)).
- **Old assertions:** The existing tracker assertion still expects `Catalog item not stated`; the service assertion still expects the same blocker; and the nested-repository test still expects the emptied outer repository to be unfinished ([tracker.test.mjs:120-132](</home/wilder/dsh-test/dsh-completion-gate/tests/tracker.test.mjs#L120-L132>), [service.test.mjs:667-678](</home/wilder/dsh-test/dsh-completion-gate/tests/service.test.mjs#L667-L678>), [service.test.mjs:882-904](</home/wilder/dsh-test/dsh-completion-gate/tests/service.test.mjs#L882-L904>)). The skeleton delta and T1 acceptance criteria assign these updates. These assertions remain unchanged because no product code or tests changed in this review.
- **Unrelated mark:** The tracker preserves an unrelated mark on reopen; status renders catalog item states; the advisory filters unrelated items ([tracker.js:126-145](</home/wilder/dsh-test/dsh-completion-gate/lib/tracker.js#L126-L145>), [report.js:11-17](</home/wilder/dsh-test/dsh-completion-gate/lib/report.js#L11-L17>), [report.js:101-105](</home/wilder/dsh-test/dsh-completion-gate/lib/report.js#L101-L105>)). C4 keeps that distinction ([skeleton.md:79-81](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L79-L81>)).
- **C7 prompt:** T3 owns the history wording and retention of adopt/register/attest/demonstrate guidance. The live prompt still has the old unrelated-mark instruction because no source changed ([skeleton.md:108-117](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L108-L117>), [index.js:675-678](</home/wilder/dsh-test/dsh-completion-gate/lib/index.js#L675-L678>), Kata `personal#jc2f`). This is implementation work, not a round-two document mismatch.

## Dispositions

| Prior finding | Disposition | Evidence |
|---|---|---|
| [P1] T2 recorder-only test fixtures | RESOLVED | The skeleton names all six affected fixtures and says direct-edit fixtures add serialized `tool/call` events while shell-only and other-writer controls keep no call ([skeleton.md:142-147,154-156](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L142-L147>)); T2 `nqce` lists all six tests. |
| [P2] T1 stop-advisory count test | RESOLVED | T1 adds the stop-message test and omits a per-item line for the unstated item; the spec, C5, delta, and hook align ([spec.md:58](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md#L58>), [skeleton.md:91,148,158](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L91-L158>), Kata `personal#33zv`). |
| [P2] C1 host mutation predicates | RESOLVED | C1 names the host predicates and raw JSON string; the host `mutationPath` matches those predicates ([skeleton.md:43-45](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L43-L45>), [capture.ts:99-112](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/capture.ts#L99-L112>)); T2 covers accepted, malformed, incomplete, and rejected calls. |
| [P2] C2 canonical path spelling | RESOLVED | C2 requires the host's canonical path handling and adds symlink/missing-leaf coverage ([skeleton.md:55-58,155](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L55-L58>)); the host resolves against `cwd` and canonicalizes the longest existing ancestor ([recorder.ts:156-165](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/recorder.ts#L156-L165>), [paths.ts:49-63](</home/wilder/git-repos/deepseek-harness-020/packages/deliverables/workspace-changes/src/paths.ts#L49-L63>)). |
| [P2] Bound authorship claims to path evidence | PARTIAL | The solution and T2 body now state path overlap and the same-path ceiling ([spec.md:17,61,90](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md#L17-L90>), Kata `personal#nqce`); US5 and the T2 title still claim the session wrote the file ([spec.md:43](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md#L43>), Kata `personal#nqce` title). Finding 1 addresses the remaining language. |
| [P2] Remove T2's behavior-independent T1 blocker | RESOLVED | T2 `nqce` has `Blocked by: None` and a shared-file coordination note; T3 `jc2f` remains blocked by T1 `33zv`. The skeleton maps R4/R5 to T2 ([skeleton.md:169-170](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L169-L170>)). |
| [P2] Trace R2 to report contracts only | RESOLVED | C7 satisfies R1 only and R2 maps to C4/C5 and T1 ([skeleton.md:108-115,167](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L108-L115>)). |
| [P2] Put the C5 count before the full catalog list | RESOLVED | The spec, C5, T1, and its hook put the count before the full list ([spec.md:58](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/spec.md#L58>), [skeleton.md:91,158](</home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/skeleton.md#L91-L158>), Kata `personal#33zv`). Finding 2 is a separate zero-count condition gap. |

## Possible concerns

None beyond the two findings.

## Verification

The round-two goal was to disposition the eight prior findings and resolve the remaining questions while writing only this report. The revised skeleton lint passed. I did not rerun `npm test` because product code and tests remain unchanged, and I did not retry the combined lint/drift job because its output was lost; the earlier isolated drift result is recorded below. Gate commands ran from `/home/wilder/dsh-test/dsh-completion-gate`; the host Git command ran from `/home/wilder/git-repos/deepseek-harness-020`.

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
exit code: 0 (measured in round 1 at unchanged code HEAD; pre-implementation baseline only)
```

```text
$ git status --short --untracked-files=all
 M docs/work/k42t-adoption-and-direct-edits/spec.md
?? docs/work/k42t-adoption-and-direct-edits/reviews/01-review.md
?? docs/work/k42t-adoption-and-direct-edits/reviews/02-review.md
?? docs/work/k42t-adoption-and-direct-edits/skeleton.md
$ git branch --show-current
main
$ git rev-parse HEAD
25b20cac6c00f62d24d006507cbd520d43342c38
$ git check-ignore -v /home/wilder/dsh-test/dsh-completion-gate/docs/work/k42t-adoption-and-direct-edits/reviews/02-review.md
(no output; exit code 1 before report creation, so the destination is not ignored)
```

```text
$ git rev-parse HEAD && git status --short -- packages/deliverables/workspace-changes/src/capture.ts packages/deliverables/workspace-changes/src/types.ts packages/deliverables/workspace-changes/src/index.ts packages/deliverables/workspace-changes/src/recorder.ts packages/deliverables/workspace-changes/src/paths.ts packages/core/agent-loop/src/tool-calls.ts packages/llm/llm/src/types.ts packages/core/agent-loop/tests/coverage-edges.spec.ts packages/subagent/subagent/lib/index.js
e24132af4f9eeea9218da00523e26e8450c3db35
(no output)
$ kata --project personal show dtmb
$ kata --project personal show 33zv
$ kata --project personal show nqce
$ kata --project personal show jc2f
exit code: 0 for each; all four records are open; T2 is unblocked and T3 remains blocked by T1.
```

The earlier isolated drift check in round 1 reported `M1:mutationPath` missing at this pre-implementation HEAD. A combined round-two lint/drift job ended with exit code 1, but its output could not be recovered after `job_output` returned `unknown job`; this review does not attribute that exit to either subcommand. The isolated round-two skeleton lint above passed.

## Unverified risks

- The feature is not implemented at HEAD. The 277 passing tests are a pre-change baseline, not evidence that the planned behavior works.
- The host change record contains no author field, so path overlap cannot establish who caused a same-path change. The spec and T2 accept that ceiling.
- The zero-count output remains unresolved until Finding 2 is fixed and a zero-count assertion is added.
- No code or test file changed in this review, so no implementation behavior was exercised.

## Verdict

The revised documents resolve seven prior findings and partially resolve one, but two remaining P2 gaps still need correction before implementation: the user story and T2 title overstate authorship, and the zero-count summary-line behavior is undefined.

VERDICT: CHANGES
