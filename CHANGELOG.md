# Changelog

## 0.1.1

- Add a bounded premature-stop guard for natural stops that clearly indicate unfinished work.
- Continue automatically when the latest assistant step contains explicit pending-action language (`now I need`, `next I will`, `let me inspect`, `in parallel`, etc.).
- Continue automatically when a tool-using turn ends on reasoning-only output with no user-facing completion.
- Default to root-agent gating only (`gateSubagents: false`) so Completion Gate does not interfere with autonomous subagent lifecycles.
- Cap forced continuations per turn to prevent Stop-hook loops.

## 0.1.0

- Initial evidence-backed production-readiness completion barrier.
