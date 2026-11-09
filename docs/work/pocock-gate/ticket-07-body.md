## Parent

personal#yhxg (Spec: dsh-completion-gate as an advisory multi-repository completion tracker)

## What to build

The plugin documentation matches the advisory tracker. `README.md` is rewritten for the current behavior: the problem, the scanner, the per-session ledger, claims, the catalog at `.dsh/verification.json` with its comment on what each item proves, the attestation and its assumed state, reopening on change, the batched stop message, the settings, the commands, the accepted limits of the change recorder, and the fact that the gate executes nothing and believes the model. `CHANGELOG.md` gains a 0.2.0 entry describing the redesign. `SECURITY.md` is updated: no verification command is ever executed, the catalog is operator-readable knowledge, and the credential scan still runs on added lines. `docs/` files that describe the old design are updated or retired.

The Completion section of `/home/wilder/.dsh/AGENTS.md` is rewritten for the new workflow: read `.dsh/verification.json` in every repository the session changes, adopt the items that fit, register new items with a comment on what each proves, run them yourself, claim or reject every changed file, review every changed code file the session claims (a separate reviewer subagent is the recommended pattern), check the changed docs it has not rejected for staleness, bloat, and conflicting information, then attest last. It states the assumed state, that the gate runs nothing, and that the gate believes the model. It replaces the current paragraph that describes a gate that runs detected checks and a BLOCKED result.

## Acceptance criteria

- [ ] README describes the advisory model and contains no claim that the gate runs checks, recipes, or temporary probes, and no BLOCKED banner.
- [ ] README documents the catalog path, the item states, reopening, the one-message-per-prompt rule, and the accepted limits.
- [ ] CHANGELOG has a 0.2.0 entry.
- [ ] SECURITY matches the no-execution model.
- [ ] The AGENTS.md Completion section names register, attest, the assumed state, the code review promise with the subagent pattern, the docs check, the catalog path, and that the gate runs nothing and believes the model.
- [ ] No stale reference to a removed setting, action, or module remains in the docs.
- [ ] No em dashes in the edited files.

## Verify

`cd /home/wilder/dsh-test/dsh-completion-gate && npm run check && npm test` and a read-through of the four edited documents plus the AGENTS.md section.

## Blocked by

- personal#dr0t
- personal#3k74

## Deliverables

The rewritten README, CHANGELOG, SECURITY, docs files, and the AGENTS.md Completion section.
