# Disposition of the Spec-axis finding S1 (advisory per-file reviewed state)

Reproduced: lib/report.js:82-88 groups files by claim and never prints the reviewed flag; the unreviewed code
files and unchecked documents are separate lists. Statement true; requirement not established.

Not accepted, by design. Evidence:

1. Ticket tz9r assigns the two surfaces different content in one sentence: "`status` prints each file's claim and
   reviewed state. The advisory message keeps listing unreviewed changed code files and the missing documentation
   check, and keeps telling the model to review every changed code file the session claims, check every changed
   document it has not rejected, and then honestly attest." Acceptance criterion 6 repeats exactly that, narrower
   than the reviewer's reading. "Keeps" says the advisory's file listing is unchanged, with review state carried by
   the unreviewed list.
2. Decision 8's next clause would be redundant under the reviewer's reading: "the files by claim state and reviewed
   state, the code files not yet reviewed, the documentation check when it is missing". If each per-file line carried
   the flag, "the code files not yet reviewed" would add nothing.
3. The approved document delta already places this display: spec comment 01M6VJH4S4GQ9B6KXV635QQN0S ("Document delta
   APPROVED at round 5 ... per-file reviewed state, review scope limited to code the session claims, honest
   attestation, ticket 06's [panel]") and comment 01M6VERXDZ9TG3P57QGYA4MDP0 item 4 ("ticket 06's runtime-status
   sentence and acceptance criteria now name each changed file's claim and reviewed state"). The per-file
   claim-and-reviewed display lives in `status` (Decision 9) and ticket 06's panel; the advisory carries the nag.
4. Not introduced by this change: `repositorySection` grouped files by claim before this ticket and the diff removed
   no reviewed display. The finding-gate criterion that a finding is introduced by the reviewed change fails.
5. Functionally the message still conveys each claimed file's review state: a claimed path appears under
   "Changed code not reviewed yet:" exactly when it is unreviewed, so the union of "Claimed as yours:" and that list
   names the state of every claimed file. The advisory stays an obligations list; the full per-file state is `status`,
   which now prints `- <path> (<claim>, <reviewed|unreviewed>)` (lib/report.js:13).
