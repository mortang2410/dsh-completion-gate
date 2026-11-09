## Parent

personal#yhxg (Spec: dsh-completion-gate as an advisory multi-repository completion tracker)

## What to build

The settings surface shrinks to the keys that still do something: `enabled`, `gateSubagents`, `preventPrematureStops`, `prematureStopMaxContinuations`, `securityScan`, and `maxChangedFiles`. The mode, machine-check, recipe, temporary-verifier, custom-check, attestation-toggle, changed-workspace-toggle, command-timeout, output-bound, and nudge-limit keys are removed from defaults, the editable keys, the settings summary, and the panel. The settings schema version becomes 2, so a saved schema-1 file is ignored and the profile configuration applies until the next save. The bundle patch carries the surviving defaults.

The control-center panel shows the surviving behavior and advisory settings, a runtime status with one row per session and one block per repository (label, claim counts, the claim and reviewed state of each changed file, item states, attested or stale), and a pending count. The machine-evidence, completion-evidence, execution-limits, verification-sources, custom-check, and verification-overview sections are removed. The header indicator reports the pending repository count or that the gate is off. The `/state` endpoint returns the new shape and no longer returns the verification overview.

## Acceptance criteria

- [ ] The settings summary has exactly the six surviving keys.
- [ ] A saved schema-1 settings file is ignored; a schema-2 file is read.
- [ ] The editable keys, defaults, and bundle patch agree.
- [ ] `/state` returns settings, sessions with repository rows, and a pending count, and no verification overview.
- [ ] The panel renders only the surviving settings and per-repository status, and each repository block shows each changed file's claim and reviewed state.
- [ ] Save and reset still work against the new schema.
- [ ] The suite is green.

## Verify

`cd /home/wilder/dsh-test/dsh-completion-gate && npm run check && npm test`

## Blocked by

- personal#dr0t
- personal#f3za
- personal#tz9r

## Deliverables

The reduced settings schema, the rewritten control-center panel, the new `/state` snapshot, and their tests in the plugin repository `/home/wilder/dsh-test/dsh-completion-gate`.
