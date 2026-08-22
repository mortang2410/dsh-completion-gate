# dsh-completion-gate

Evidence-backed production-readiness barrier for DeepSeek Harness.

## v0.1.1 hotfix: premature natural stops

DSH's `agent/turn-stopping` means a model has naturally stopped with no live tool call or queued continuation. Some models can nevertheless stop while their own output clearly says work remains. Completion Gate now detects strong unfinished-work evidence and steers one more step before readiness validation.

Examples:

- `Now I need to inspect...`
- `Next I will run...`
- `Let me trace...`
- `...and in parallel...`
- a tool-using turn that ends with reasoning but no user-facing text

The guard is bounded:

```yaml
preventPrematureStops: true
prematureStopMaxContinuations: 3
```

It does not treat generic prose such as `let me know` as unfinished work.

## Root agent by default

```yaml
gateSubagents: false
```

Completion Gate does not intercept spawned child/subagent stop boundaries unless explicitly enabled. This keeps it compatible with Phoenix/model failover and autonomous team orchestration.

## Production gate

When code has changed, Completion Gate runs detected tests/build/lint/typecheck checks, scans added code for new TODO/FIXME markers and a small set of high-confidence security regressions, then requires a fingerprint-bound changed-file/acceptance-criteria attestation before allowing completion.

## Install

Use the extracted source directory with DSH and restart `dsh web`.
