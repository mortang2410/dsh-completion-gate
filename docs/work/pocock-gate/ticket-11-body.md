## Parent

personal#yhxg (Spec: dsh-completion-gate as an advisory multi-repository completion tracker)

## What to build

The stop advisory speaks at most once since the last real user message, instead of at every stop bounded per change set. In the stop handler, key the message on the prompt, not on the change set: a state flag records the prompt turn the gate last spoke in, and a second stop of the same prompt returns without speaking even when the change set changed. A real user message re-arms exactly one message. The host's stop signal is an attempt to end; because the gate cannot know which attempt is the last one, it takes the first attempt of the prompt that has something to say and stays silent at every later attempt.

The gate's own steer must not re-arm it: the steered continuation stays inside the same turn, so keying on the turn is the mechanism, and the premature-stop recovery followup must also not re-arm, because it is not a real user prompt. Detect a real prompt from the session's user message for the turn (its source is not the gate's), not from the turn number alone.

Every notice rides the one message: the per-repository introduction, the undetermined change set, the credential hit, the unreadable nested repository, and the attribution failure. A notice recorded after the message waits for the next real user prompt; the gate stays silent for the rest of the turn.

Remove the per-change-set nudge bound and its fingerprint key. The `verificationNudgeLimit` setting is no longer consulted; ticket 06 removes it from the schema, so this ticket leaves the key intact and dead until then. `enabled` false still silences the gate. The message text and its claim, review, documentation, and item content do not change; ticket 10 owns that content.

## Acceptance criteria

- [ ] A user prompt with unfinished work produces exactly one advisory, at the model's first attempt to end where there is something to say.
- [ ] A second stop of the same prompt sends nothing, even when the change set changed.
- [ ] A new real user message re-arms exactly one message.
- [ ] The gate's own steer and the premature-stop recovery followup do not re-arm it.
- [ ] The introduction and every notice ride the one message; a notice after it waits for the next real prompt.
- [ ] `verificationNudgeLimit` is not consulted; `enabled` false silences the gate.
- [ ] The existing suite stays green.

## Verify

`cd /home/wilder/dsh-test/dsh-completion-gate && npm run check && npm test`

## Blocked by

- personal#f3za

## Deliverables

The one-message-per-prompt trigger in `lib/index.js`, the removed nudge bound, and their tests in `/home/wilder/dsh-test/dsh-completion-gate`.
