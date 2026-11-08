# Changelog

## 0.2.0

Advisory multi-repository completion tracker. The gate no longer runs verification. It attributes changed files to the repositories that own them, records the model's claims, and reminds the model once per user prompt.

- Resolve every changed file from the host's turn-scoped change record to the nearest repository that owns it, including nested repositories, with the session workspace as the fallback.
- Keep one in-memory completion ledger per session per repository, with the changed files, their content keys, claim decisions, reviewed states, catalog item states, and one attestation bound to a digest of the changed paths and contents.
- Add claims of `mine`, `not-mine`, and unclaimed. The gate believes either decision and never audits authorship.
- Add the per-repository verification catalog at `.dsh/verification.json`, with a required `proves` comment per item and an optional command for reproducibility. Register merges by name and keeps the item id. The catalog is ignored through the repository's local exclude file and is never executed.
- Add the `passed`, `assumed`, and `unrelated` item states. An assumed item requires a reason and is always reported as a promise, not a pass.
- Reopen a repository when a recorded path is added or a recorded file's content changes after its attestation, clearing claims, reviews, and item states except an unrelated mark.
- Send at most one batched advisory message per user prompt, with an introduction for each repository the session sees for the first time. The message advises, never says BLOCKED, and never claims a check failed.
- Keep the added-line security scan and report its hits with the rule and count, never the matched text.
- Keep the Premature Stop Guard and its continuation cap.
- Keep the `register`, `attest`, and `status` tool actions with the advisory behavior. The `run`, `recipe`, and `temporary_verify` actions and the `/gate-override` command are removed.
- Reduce the settings to `enabled`, `gateSubagents`, `preventPrematureStops`, `prematureStopMaxContinuations`, `securityScan`, and `maxChangedFiles`. The settings schema becomes version 2.
- Retire the machine-check runner, check detection, recipes, the recipe runner, the temporary verifier, the verification ledger, custom checks, the acceptance-criteria field, the TODO scan, the mode switch, and the operator override.
- Rewrite the README, SECURITY.md, and the Completion section of the host AGENTS.md for the advisory workflow.
- Bump the package version to 0.2.0.

## 0.1.3

- Fix Premature Stop Guard recovery that could show a context injection and then immediately return the agent to idle.
- Premature-stop recovery now uses `agent.followup()` to schedule a fresh turn instead of same-turn `agent.steer()`.
- Keep Production Readiness blocking on `agent.steer()` because that path must veto the current completion boundary.
- Make the premature-stop continuation cap span the recovery chain across turns.
- Retry a bounded empty recovery turn instead of silently stopping immediately.
- Update Control Center wording and README to describe follow-up recovery semantics accurately.
- Revert the premature-stop guard widening that came out of the review loop. The guard matches its fixed pending-work phrases and work verbs again, so a first-person sentence whose verb is not on that list no longer blocks, for example "I will publish the release notes after review." The turn-event plumbing that lets the guard fire at all, and the three false-positive reductions (finished answers, advice in finished answers, reasoning-only turns with no tool call), are kept.

## 0.1.2

- Rewrite README as complete new-user documentation covering architecture, checks, attestation, commands, UI, installation, failover compatibility, limitations and security model.
- Turn Settings → Completion Gate into a real operator control center rather than a read-only status panel.
- Add live persistent configuration for behavior, machine evidence, completion evidence and execution limits.
- Add editable operator-defined custom checks.
- Add Save settings and Reset to profile defaults actions.
- Persist UI settings as a host-side overlay on profile configuration.
- Invalidate cached machine evidence, attestations and overrides whenever gate policy changes.
- Add `Gate · off` header state when the master switch is disabled.

## 0.1.1

- Add a bounded premature-stop guard for natural stops that clearly indicate unfinished work.
- Continue automatically when the latest assistant step contains explicit pending-action language (`now I need`, `next I will`, `let me inspect`, `in parallel start`, etc.).
- Continue automatically when a tool-using turn ends on reasoning-only output with no user-facing completion.
- Default to root-agent gating only (`gateSubagents: false`) so Completion Gate does not interfere with autonomous subagent lifecycles.
- Cap forced continuations per turn to prevent Stop-hook loops.

## 0.1.0

- Initial evidence-backed production-readiness completion barrier.
