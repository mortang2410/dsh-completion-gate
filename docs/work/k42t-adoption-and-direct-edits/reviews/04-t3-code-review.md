# Review: T3 system-prompt wording, an unstated catalog item is history (personal#jc2f)

- Date: 2026-11-11
- Mode: Two-axis Standards + Spec (parallel reviewers), then chained Mode 1 correctness on the same frozen commit
- Repository: `/home/wilder/dsh-test/dsh-completion-gate`
- Feature: `k42t-adoption-and-direct-edits`
- Base/head: [db0acbb](https://github.com/mortang2410/dsh-completion-gate/commit/db0acbb27409566905cb38a0052107e51185cf01) -> [6bf5d7d](https://github.com/mortang2410/dsh-completion-gate/commit/6bf5d7dbbfb3c8f9bf4d3bb11f8f50c5863eb1d3)
- Scope: commit `6bf5d7dbbfb3c8f9bf4d3bb11f8f50c5863eb1d3`, one commit, three files: `lib/index.js`, `tests/service.test.mjs`, `tests/package.test.mjs`. The untracked spec, skeleton, and earlier review reports under `docs/work/k42t-adoption-and-direct-edits/` belong to the orchestrator and are not part of this review. A follow-up commit `8026957` fixes the one P2 this review produced and is dispositioned below.
- Requirements: spec `docs/work/k42t-adoption-and-direct-edits/spec.md` (Implementation Decisions, system-prompt bullet; US1 and US10), skeleton contract C7 (owner M4, stable, satisfies R1), and ticket Kata `personal#jc2f`.
- Threat model: in scope are ordinary authoring errors in a one-sentence prompt change and its two test edits: a sentence that contradicts the approved spec, an instruction silently dropped, a test that cannot fail, or a test helper that changes production behaviour. Out of scope are hostile concurrent writers, a host that fails to register the section, and future prompt edits.
- Rounds: 1 review round (Standards and Spec axes in parallel, then chained correctness) plus one follow-up fix commit
- Reviewer route: provider `codex`, model `codex/luna-bifrost`, reasoning effort `max` (a model family different from the DeepSeek implementer)
- Publication: Report only; nothing was published to Kata or GitHub.

The T3 change replaces one sentence inside the Completion Gate system-prompt section. The old sentence reads `still owed; mark a catalog item unrelated when it does not concern this session, so it is not reported again`. The new sentence reads `still owed; an item the session does not state is history, so adopt only the items that fit this work`; the whole prompt text is 7 characters shorter. `tests/package.test.mjs` carried the old sentence as a pinned spec-section-11 clause from an earlier spec; the orchestrator authorized replacing exactly that clause because the k42t spec supersedes it and the full suite cannot pass otherwise. `tests/service.test.mjs` gains a test-only capture of the registered section in its `liveService` helper and one test over the captured text.

## Verification

```text
$ node --test tests/service.test.mjs        # before the lib/index.js edit, new test present
not ok 9 - the system-prompt section says an unstated catalog item is history
  error: 'the section must say an unstated item is history'
# pass 104
# fail 1

$ node --test tests/service.test.mjs        # after the lib/index.js edit
# pass 105
# fail 0

$ npm run check && npm test                 # frozen commit 6bf5d7d, worktree
# tests 291
# pass 291
# fail 0

$ git archive 6bf5d7d | tar -x -C ~/Trash/t3-archive && node --test tests/*.test.mjs   # archive of the reviewed commit
# tests 291
# pass 291
# fail 0

$ node ~/Trash/t3-demo.mjs                  # real use: start the service against a stub host and read the registered section
registered section: {"name":"tool:completion-gate","order":188}
says unstated is history: true
still tells mark-unrelated: false
keeps adopt/register/attest/demonstrate: true

$ cd ~/Trash/t3-teeth && node --test tests/service.test.mjs   # teeth: reviewed tests against the pre-change lib/index.js
not ok 9 - the system-prompt section says an unstated catalog item is history
  error: 'the section must say an unstated item is history'
# pass 104
# fail 1

$ node --test --test-name-pattern='the system-prompt section says an unstated catalog item is history' tests/service.test.mjs   # fix probe, scratch copy with a duplicate registration added to lib/index.js
not ok 1 - the system-prompt section says an unstated catalog item is history
  error: 'the service must register the system-prompt section once per start'
  2 !== 1

$ cd ~/Trash/t3-teeth && node --test --test-name-pattern='the system-prompt section says an unstated catalog item is history' tests/service.test.mjs   # updated test against the pre-change prompt
not ok 1 - the system-prompt section says an unstated catalog item is history
  error: 'the section must say an unstated item is history'

$ node --test tests/service.test.mjs tests/package.test.mjs   # after the follow-up fix
# tests 111
# pass 111
# fail 0

$ npm run check && npm test   # after the follow-up fix
# tests 291
# pass 291
# fail 0
```

In the demo probe, `still tells mark-unrelated: false` means the registered text does not contain the old `mark a catalog item unrelated` phrase, and `keeps adopt/register/attest/demonstrate: true` means all four retained instructions are present. The teeth probe is a scratch tree holding the test file with the pre-change `lib/index.js` from db0acbb.

Static scan on the reviewed tree, every changed file including tests:

```text
$ cccc lib/index.js tests/service.test.mjs tests/package.test.mjs
3 files, 310 functions, parse errors 0; cognitive sum 238 (max 35, median 0, p90 1, p95 3);
cyclomatic sum 578 (max 30, median 1, p90 3, p95 5).
Per file: lib/index.js cognitive 180 / cyclomatic 296; tests/service.test.mjs 51 / 267; tests/package.test.mjs 7 / 15.

$ lizard -l js lib/index.js tests/service.test.mjs tests/package.test.mjs
1538 nloc, 304 functions, avg NLOC 5.4, avg CCN 1.8.
Warnings (CCN > 15): turnChanges lib/index.js:230 CCN 17; stopping lib/index.js:368 CCN 28;
repositoryReport lib/index.js:480-543 CCN 19. The diff touches none of these functions; it adds no product-code
function and one test callback.
```

The teeth check is separate from the red-first run: it copies the test file into a scratch tree and puts the pre-change `lib/index.js` from `db0acbb` beside it. Only the new prompt test fails, so the test pins the prompt text rather than passing by construction.

## Findings

## Standards

The Standards reviewer found no hard documented-standard violation. Its words: "no hard documented-standard violations found. The supplied repo facts and root docs provide no coding standard; the README documents behavior, while SECURITY/CHANGELOG add no applicable coding rule. I confirmed the reviewed diff and excluded the untracked/modified docs under `docs/work/k42t-adoption-and-direct-edits/`." The complexity warnings reported in the static scan sit in functions the diff does not touch; the diff adds no product function.

### [P3] Duplicated prompt-clause assertion in the service test (judgement call) - tests/service.test.mjs:26

The reviewer's words: "`tests/service.test.mjs:26` repeats the prompt-clause inclusion loop already present in `tests/package.test.mjs:66-78`. The overlapping shape is `for (... of [...]) assert.*(text.includes(...))`; the service test additionally exercises the real section passed to the host stub, so this is low-risk overlap rather than a hard violation. Fix: in `tests/service.test.mjs`'s new test, keep the runtime-only name/order, changed-phrase, and obsolete-phrase assertions, and drop the preserved-clause list already pinned by `tests/package.test.mjs`; probe with `node --test tests/service.test.mjs tests/package.test.mjs` to confirm both test boundaries still pass."

Disposition: rejected as not a defect, with evidence. The two tests guard different seams. `tests/package.test.mjs` slices the system-prompt source text out of `lib/index.js`; it would still pass if the service stopped registering the section at all. `tests/service.test.mjs` starts the service against a stub host and reads the section the host receives, which is the only check that the registered text carries T3's acceptance criterion "the adopt, register, attest, and demonstrate instructions stay". The skeleton's C7 verification hook is `node --test tests/service.test.mjs`, so removing those assertions would leave that hook unable to see the instruction-retention part of C7. Two independent pins on two seams are intentional defence, not extractable shared logic; a shared constant across test files would couple them and make one edit silently change both tests. Both files pass on the reviewed commit (`tests/service.test.mjs` 105/105, `tests/package.test.mjs` 6/6), and the reviewer's proposed probe `node --test tests/service.test.mjs tests/package.test.mjs` gives `# tests 111 / # pass 111 / # fail 0`.

Standards result: the reviewer's verdict is `minor fixes` for that one low-priority heuristic; the orchestrator rejects the finding, so no Standards change is owed.

### Documentation observation, not a finding

`tests/package.test.mjs:58` still names the test "the system-prompt paragraph carries every instruction spec section 11 names", and its comment says each clause comes from spec section 11. After T3, one clause in that list ("an item the session does not state is history, so adopt only the items that fit this work") comes from the k42t spec, not section 11. The orchestrator authorized changing only the one clause string, so the title and the comment were left alone; the list is now eight clauses from section 11 plus one from the k42t spec. A follow-up may rename the test to name both specs. No product behavior depends on it.

## Spec

The Spec reviewer found nothing: no requested requirement missing or partial, no unasked behavior in the reviewed diff, and no requirement implemented incorrectly. Its words:

> (a) **Missing or partial requirements:** None. The section says an unstated item is history, preserves the adopt, register, attest, and demonstrate instructions, and keeps its name and order.
>
> (b) **Scope creep:** None. The `tests/package.test.mjs:74` wording update matches the explicitly authorized stale-clause change.
>
> (c) **Incorrect implementation:** None.
>
> **Tests:** `node --test tests/service.test.mjs` passed 105/105; `npm run check && npm test` passed, with 291/291 tests.
>
> VERDICT: clean

Spec result: `clean`. The extra `tests/package.test.mjs` edit was checked against the orchestrator's one-string authorization and found to be exactly that.

## Correctness

### [P2] Assert exactly one prompt registration - tests/service.test.mjs:13

The reviewer's words: "`liveService` assigns each callback to `prompt.section`, replacing any earlier definition. If `CompletionGateService.start()` registers the same compliant section twice, the new C7 test reads only the last one and passes, so it does not enforce skeleton C7's 'registered once per service start' invariant. Fix: capture registrations in an array, assert there is exactly one, then check that entry's name/order/text. This is a regression-test gap, not a current duplicate: source has one `systemPrompt.section` call at `lib/index.js:677`."

Status: confirmed and fixed in follow-up commit [8026957](https://github.com/mortang2410/dsh-completion-gate/commit/80269571b4627b2ab4439f3cf9ec8c4dfded844a). `liveService` now appends every registered definition to `prompt.sections`, and the test asserts `sections.length === 1` before reading the entry and checking its name, order, and text. The orchestrator injected a duplicate registration into a scratch copy at `/home/wilder/Trash/t3-mutation` and the test failed with `the service must register the system-prompt section once per start` and `2 !== 1`; the updated test against the pre-change `lib/index.js` in `/home/wilder/Trash/t3-teeth` still fails on the history wording. After the fix, `node --test tests/service.test.mjs tests/package.test.mjs` is 111/111 and `npm run check && npm test` is 291/291.

The reviewer also corrected the prior axis in the orchestrator's favour: "the Standards-axis rejection of the P3 duplicated-assertion suggestion is sound. `package.test.mjs` slices source text, while the new service test invokes the real `start()` through a host stub and fails if no section is registered; a source-only pin could pass after registration was removed. The service test's overlapping clause checks cover the required runtime seam. The test-only stub preserves the old disposer behavior (`off()` still returns a function) and adds no production behavior."

Correctness result: `minor fixes`, kept from the two-axis aggregate. No other correctness finding and no possible concerns. The reviewer did not independently rerun the red-first or scratch-mutation probes; the orchestrator ran both and recorded them under Verification.

## Possible concerns

None. The correctness reviewer reported no possible concerns.

## Verdict

The two-axis aggregate is the worse of the axis verdicts: Standards `minor fixes`, Spec `clean`. The chained correctness stage also returned `minor fixes`, which may only keep or worsen that value. One finding was open on the reviewed commit: the P2 registration-count gap, now fixed in follow-up `8026957` and verified by the duplicate-registration probe. The Standards P3 was rejected with evidence, and the correctness reviewer agreed the rejection is sound. No other finding or possible concern remains.

VERDICT: minor fixes

The verdict describes reviewed commit `6bf5d7d`. The follow-up `8026957` fixes the only P2; no reviewer has revisited that commit, so its resolution is fixer-verified, not reviewer-confirmed. The Standards P3 stays rejected, not fixed.

## Dispositions

| Finding | Disposition | Evidence |
|---|---|---|
| [P2] Assert exactly one prompt registration (Correctness) | FIXED, not reviewer-confirmed | `tests/service.test.mjs:13,27`; duplicate-registration probe fails with `2 !== 1`; pair 111/111, full suite 291/291; no re-review round was run |
| [P3] Duplicated prompt-clause assertion (Standards) | REJECTED | `tests/package.test.mjs` pins a source slice, while the service test pins the section the host receives; the correctness reviewer confirmed the rejection |

## Separate follow-up disposition

Follow-up commit [80269571b4627b2ab4439f3cf9ec8c4dfded844a](https://github.com/mortang2410/dsh-completion-gate/commit/80269571b4627b2ab4439f3cf9ec8c4dfded844a) changes only `tests/service.test.mjs` (5 insertions, 4 deletions): the capture becomes an array and the test asserts exactly one registration. It does not change product code. The orchestrator ran the fix probe, the teeth probe, the two prompt test files, and the full suite as recorded above. This fixes the P2 on the reviewed commit without changing its verdict; a reviewer has not revisited the follow-up.

## Unverified risks

- The running DSH host still serves the previous prompt. The host unit entered its current run at 2026-11-11 05:33:13 +07, before the reviewed commit at 09:38:44; the plugin is linked into the `web` profile (`"dsh-completion-gate": "link:/home/wilder/dsh-test/dsh-completion-gate"`) and loads when the host starts. The new text therefore reaches a session after the next host restart. No restart was performed for this review, so the live activation is unverified.
- The test reads the section object the host stub receives, not the assembled system prompt. The host stores a section by name (`packages/core/system-prompt/src/index.ts:454-463`), and that registration path was read, but the assembly that renders the prompt was not exercised from this repository's suite.
- The `unrelated` item state stays in the tool contract and the report, but the prompt no longer mentions it. Whether sessions still use it as an audit note is a behavioural question that no test in this change can answer, and it is outside T3's scope.
