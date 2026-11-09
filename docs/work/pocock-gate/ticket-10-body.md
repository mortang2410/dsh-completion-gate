# 10: Per-file reviewed state

Ticket 10 of spec personal#yhxg. It makes the reviewed state of a changed file explicit and visible, so the gate shows which changed files are still unreviewed and keeps nagging for the review and the attestation.

## What to build

The tracker stores a reviewed state on every changed file, next to its claim. A file starts unreviewed when the session first records it. The attestation is the only thing that marks review: each path in `reviewed_code_files` becomes reviewed, and a true documentation check marks every recorded documentation file reviewed. The latest attestation decides the state, so a file it does not cover is unreviewed. Reopening clears the reviewed state together with the claims.

`status` prints each file's claim and reviewed state. The advisory message keeps listing unreviewed changed code files and the missing documentation check, and keeps telling the model to review every changed code file the session claims, check every changed document it has not rejected, and then honestly attest. A claimed code file that is not reviewed stays a problem; a rejected file carries no review obligation.

## Acceptance criteria

- [ ] Every recorded changed file starts unreviewed.
- [ ] Attest marks the reviewed code files reviewed, and marks recorded documentation files reviewed when `docs_checked` is true.
- [ ] A file the latest attestation does not cover is unreviewed.
- [ ] Reopening clears every file's reviewed state.
- [ ] `status` prints each file's claim and reviewed state.
- [ ] The advisory lists an unreviewed claimed code file and the missing documentation check, and tells the model to review and honestly attest.
- [ ] The existing suite stays green.

## Verify

`cd /home/wilder/dsh-test/dsh-completion-gate && npm run check && npm test`. Each new test fails when the reviewed state, its clearing, or its display is removed.

## Blocked by

- personal#f3za
- personal#x9af (the trigger lands first because it rewrites the stop-message tests this ticket's advisory assertions run in)

## Deliverables

- `lib/tracker.js`, `lib/report.js`, and their tests in `/home/wilder/dsh-test/dsh-completion-gate`.
- The advisory nag stays in `lib/report.js`; the control-center panel display is ticket 06.
