# Changelog

## 0.1.3

- Fix Premature Stop Guard recovery that could show a context injection and then immediately return the agent to idle.
- Premature-stop recovery now uses `agent.followup()` to schedule a fresh turn instead of same-turn `agent.steer()`.
- Keep Production Readiness blocking on `agent.steer()` because that path must veto the current completion boundary.
- Make the premature-stop continuation cap span the recovery chain across turns.
- Retry a bounded empty recovery turn instead of silently stopping immediately.
- Update Control Center wording and README to describe follow-up recovery semantics accurately.

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
- Continue automatically when the latest assistant step contains explicit pending-action language (`now I need`, `next I will`, `let me inspect`, `in parallel`, etc.).
- Continue automatically when a tool-using turn ends on reasoning-only output with no user-facing completion.
- Default to root-agent gating only (`gateSubagents: false`) so Completion Gate does not interfere with autonomous subagent lifecycles.
- Cap forced continuations per turn to prevent Stop-hook loops.

## 0.1.0

- Initial evidence-backed production-readiness completion barrier.
