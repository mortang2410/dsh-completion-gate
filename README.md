# dsh-completion-gate

**Completion Gate** is a DeepSeek Harness plugin that prevents a coding agent from successfully ending a changed task until there is evidence that the work is actually ready.

It combines two related safeguards:

1. **Premature Stop Guard** — if a model naturally stops while its own latest output clearly says that work is still pending, the plugin schedules a fresh DSH follow-up turn that resumes the unfinished task.
2. **Production Readiness Gate** — once code has changed, the root agent must produce machine evidence and a structured final review before the turn is allowed to close normally.

The goal is not to make the model *say* that tests passed. The goal is to make DSH execute the available checks, bind the result to the current repository state, and reject stale or incomplete completion evidence.

---

## Why this plugin exists

LLM coding agents frequently stop in one of these states:

```text
"Now I need to inspect the call site..."
→ tool call
→ reasoning
→ model naturally stops
```

or:

```text
"Implemented. Looks good."
```

without having actually run the repository's tests, build, lint, typecheck, or reviewed every changed file.

Completion Gate adds a host-side boundary around those failure modes.

```text
Agent works
   │
   ├── model stops while clearly unfinished
   │       └── Premature Stop Guard → continue
   │
   └── model appears genuinely finished
           │
           └── Completion Gate
                  ├── repository changed?
                  ├── tests
                  ├── build
                  ├── lint
                  ├── typecheck
                  ├── TODO/FIXME regression scan
                  ├── security regression tripwires
                  ├── changed-file review
                  └── acceptance criteria → evidence
                           │
                     PASS ─┴─ BLOCK
```

---

## Core behavior

### 1. Premature Stop Guard

DSH exposes `agent/turn-stopping` when a model has naturally stopped and no tool call or queued continuation is still keeping the turn alive.

Completion Gate inspects the latest turn for strong evidence that the model itself said work remained, for example:

- `Now I need to inspect...`
- `Next I will run...`
- `I still need to...`
- `Let me trace...`
- `...and in parallel...`
- reasoning-only output after tool work with no user-facing completion

When detected, the plugin queues a waking `agent.followup()` for a fresh turn such as:

```text
PREMATURE STOP RECOVERY:
Continue the unfinished task.
Execute the pending investigation or implementation now.
Do not summarize or claim completion yet.
```

The recovery chain is bounded by `prematureStopMaxContinuations`, so repeated premature/empty recovery turns cannot create an infinite follow-up loop.

Generic phrases such as `Let me know if you want changes` are not treated as unfinished work.

### 2. Root-agent completion authority

By default:

```yaml
gateSubagents: false
```

Only the root agent owns final production readiness. Spawned DSH subagents are allowed to complete their delegated jobs normally.

This is the recommended setting when using autonomous orchestration, Phoenix/model failover, AI Council, critics, or large subagent teams. The root agent remains responsible for integrating the work and passing the final gate.

You can explicitly enable subagent gating from the control center if a project really needs it.

### 3. Turn-scoped changed files

Completion evidence is tied to the turn's own change record, not to a fingerprint of the whole repository.

The changed-file list comes from the host's `@deepseek-ai/dsh-workspace-changes` recorder, which snapshots the working tree at turn start and turn end and diffs the two. That means:

- a file that was already modified before your turn is part of the turn-start baseline and is **not** attributed to you, so unrelated work in the tree no longer blocks you;
- a file written during the turn by any process inside the repository, including a shell command, **is** attributed to you;
- gitignored build output is not attributed to you;
- a file under the system temporary directory counts only when it lies inside the repository.

When a turn changes nothing the recorder announces no summary, which is its normal silence. When the recorder is not mounted at all, or a record cannot be read, the gate reports that the changed files **cannot be determined** rather than assuming the workspace was unchanged.

Evidence is keyed by the session, the turn and the record's sequence number, plus a digest of the recorded file list. Changing the code in a later turn therefore invalidates earlier evidence, while touching a file or writing build output does not.

A turn whose every changed path is documentation or data runs no behavioral check and is not asked for a test command. The added-line TODO and credential scans still read its diff, and you must still attest to every changed file.

### 3a. Verification sources

One inventory decides where verification comes from, and the stop hook, the runner and the tool handler all read that same decision:

| Source | When it applies |
| --- | --- |
| Canonical checks | A detected or operator-defined check exists. It always has authority and is never replaced. |
| Recipe | No canonical check exists, but a recipe can bootstrap, build, test or boot the project. |
| Temporary verifier | No canonical check and no usable recipe exist, and you ask for the last-resort probe. |
| None | A documentation-only turn, which needs no behavioral verification. |

A passing verification covers the missing-test-command condition only. It never clears the TODO scan, the credential scan, the changed-file review or the acceptance-criteria attestation, and it never excuses a check that actually failed.

### 3b. The temporary verifier

When nothing else exists, you write a small script and the gate runs it. The path must be absolute, lie under the system temporary directory, sit outside the repository, be a regular file, carry the `dsh-verify-` name prefix and stay under the size cap. The script runs directly with an argument vector and no shell, so an appended `|| true` cannot mask a failure. A path spelled under `/tmp` is also resolved through symlinks, so a link pointing back into the repository is refused.

The gate fingerprints the project before and after the run and rejects the probe when anything differs. The fingerprint covers each file's contents, size, permission bits and modification time, each symlink's target, and the set of directories. Contents are hashed rather than size and time alone, because a rewrite of equal length with the timestamp restored would otherwise be invisible. It refuses the run outright when it cannot complete the comparison: more than 5000 entries, more than 64 MB, a file it cannot read, a directory it cannot list, or an entry it cannot describe. A refusal is a failure, never a silent pass. It kills the probe's whole process group before comparing, so a server or watcher the probe backgrounded cannot write afterwards.

Stated ceilings: the contents of `node_modules`, a virtual environment, `__pycache__` and `.git` are not compared (they are not the code under test, and walking them would breach the entry bound on nearly every Node project), and neither is anything outside the project root. A child that creates its own process group or session escapes the teardown. A script that deliberately restores content, mode, timestamp and link targets together would defeat a before-and-after snapshot, which is beyond what that comparison can prove. A passing script is deleted; a failing one is left on disk so you can repair it. A passing run is recorded as a targeted receipt: the scope label states honestly how much of the project the run exercised, and a fresh passing receipt satisfies the requirement whatever its scope.

### 3c. Verification recipes

For a project with no canonical test command, the gate can detect how to bootstrap, build, test and boot it, then poll a readiness URL and tear the process tree down. Detection covers Node (with the package manager chosen from the lockfile) and the conventional dev-server ports of Next.js, SvelteKit, Astro, Remix, Create React App and Vite, plus Python (Django, FastAPI/Uvicorn, Flask, generic), Go, Rust, Maven, Gradle, Makefile and Docker Compose.

A saved recipe at `.dsh/environment.json` wins over detection and is never rewritten by it. A readiness poll accepts **any** HTTP status, including 404 and 500, because the process answered. A Compose recipe refuses to build or start when a read-only probe cannot rule out running containers for that project.

### 4. Machine evidence

Completion Gate can auto-detect and execute common project checks.

| Ecosystem | Detection / checks |
| --- | --- |
| Node.js | package scripts such as `test`, `build`, `lint`, `typecheck` |
| npm / pnpm / Yarn / Bun | package manager selected from project lockfiles |
| Python | pytest when tests/config are present; Ruff and Mypy when configured |
| Go | `go test ./...`, `go vet ./...` |
| Rust | `cargo test --all-targets`, `cargo check --all-targets` |
| Composer / PHP | `composer test`, `composer lint` when scripts exist |
| Any project | operator-defined custom checks |

When `requireTests` is enabled, a project with **no executable test command detected** is reported as a missing harness. That condition alone is covered by a fresh passing verification (a full-scope recipe or a temporary verifier); a check that actually fails is never covered.

Successful machine results are cached for the turn's change record. This avoids rerunning a ten-minute suite merely because the agent needs one extra turn to submit its final review.

### 5. Added-code tripwires

The gate can inspect newly added lines for:

```text
TODO
FIXME
HACK
XXX
```

and a deliberately narrow set of obvious security-regression patterns such as:

- likely hard-coded credentials;
- disabled TLS certificate verification;
- `eval(...)` / dynamic `Function` construction;
- `chmod 777`;
- shell execution enablement requiring review;
- raw HTML injection surfaces.

This is a **regression tripwire**, not a replacement for dedicated SAST/security tooling.

### 6. Completion attestation

Machine checks cannot prove every requirement. Before final completion, the agent can be required to call the `completion_gate` tool with an attestation bound to the turn's change record.

Example:

```json
{
  "action": "attest",
  "reviewed_files": [
    "src/engine.ts",
    "tests/engine.test.ts"
  ],
  "review_summary": "Reviewed the complete diff, error paths, state transitions and backwards compatibility.",
  "acceptance_criteria": [
    {
      "criterion": "Risk sizing uses ATR",
      "evidence": "Unit tests cover ATR-derived risk sizing and the full test suite passes."
    },
    {
      "criterion": "Existing behavior remains compatible",
      "evidence": "Regression tests and typecheck pass; changed call sites were reviewed."
    }
  ],
  "unresolved_issues": []
}
```

In strict mode the gate verifies that:

- every changed file is listed in `reviewed_files`;
- a changed-file review summary exists;
- at least one acceptance criterion is supplied;
- every criterion has concrete evidence;
- `unresolved_issues` is empty;
- the attestation still matches the turn's change record.

---

## Control Center

Open:

**Settings → Completion Gate**

The control center is both a runtime dashboard and a persistent configuration editor.

### Behavior

- **Enable Completion Gate** — master switch.
- **Mode**
  - `Strict`: a failed gate steers the agent back and prevents normal completion.
  - `Advisory`: evidence is collected, but failure does not force another step.
- **Gate subagents** — include DSH child/subagent stop boundaries. Off is recommended for autonomous teams.
- **Premature-stop guard** — recover natural stops that clearly leave pending work by scheduling a fresh follow-up turn.
- **Max recovery follow-ups** — safety cap across one consecutive premature-stop recovery chain.

### Machine evidence

- **Auto-detect checks**
- **Require tests**
- **Require build when available**
- **Require lint when available**
- **Require typecheck when available**
- **Block new TODO/FIXME markers**
- **Security regression scan**

### Completion evidence

- **Require final attestation**
- **Gate only changed workspaces**
- **Maximum changed files**

### Execution limits

- **Check timeout** — maximum time per individual command.
- **Stored command output** — maximum sanitized failure output retained per check.

### Custom checks

The UI can add arbitrary operator-defined checks:

```text
Name: integration-tests
Category: test
Command: npm run test:integration
Required: yes
```

Custom commands execute in the project's workspace on the DSH host. Only configure commands you trust.

### Saving settings

`Save settings` applies changes immediately and persists them across `dsh web` restarts.

Configuration precedence is:

```text
built-in defaults
      ↓
profile / cordis.patch.yml configuration
      ↓
settings saved from the Completion Gate UI
```

Whenever gate policy changes, cached machine evidence, attestations, and operator overrides are invalidated. A previous PASS is never reused under a newly changed policy.

`Reset to profile defaults` removes the saved UI overlay and immediately returns to the plugin configuration supplied by the active DSH profile.

The host-side settings file is intentionally not exposed in the browser UI or gate reports.

---

## Commands

### `/gate`

Run the gate immediately for the active root session.

```text
/gate
```

Useful when you want to inspect readiness before the model tries to finish.

### `/gate-status`

Show the latest report for the active session.

```text
/gate-status
```

### `/gate-reset`

Discard cached machine evidence, attestation, and operator override for the active session.

```text
/gate-reset
```

### `/gate-override <reason>`

Explicit operator override for the **exact current change record**.

```text
/gate-override accepted temporary compatibility risk
```

If any file or commit changes afterward, the override no longer applies.

This is intended for the human operator, not as an escape hatch for the agent.

---

## Agent tool

The plugin registers:

```text
completion_gate
```

Actions:

- `run` — execute readiness checks now;
- `status` — return the latest/current report;
- `attest` — submit the final changed-file and acceptance-criteria review.

Completion Gate also adds a system-prompt section telling coding agents that the gate is authoritative before they claim completion.

---

## Header status

The conversation header shows a compact status:

```text
Gate · ready
Gate · 1 blocked
Gate · off
```

This is only an operator summary. The authoritative result remains the workspace-bound gate report.

---

## Default configuration

The bundled profile patch starts with:

```yaml
- insert:
    - id: completion-gate
      name: dsh-completion-gate
      config:
        enabled: true
        mode: strict
        gateSubagents: false
        preventPrematureStops: true
        prematureStopMaxContinuations: 3
        autoDetectChecks: true
        requireTests: true
        requireBuildWhenAvailable: true
        requireLintWhenAvailable: true
        requireTypecheckWhenAvailable: true
        blockNewTodos: true
        securityScan: true
        requireAttestation: true
        gateOnlyChangedWorkspaces: true
        commandTimeoutMs: 600000
        maxOutputChars: 12000
        maxChangedFiles: 500
        autoDetectRecipe: true
        allowTemporaryVerifier: true
        recipeReadinessTimeoutMs: 60000
        verificationNudgeLimit: 3
        customChecks: []
```

Everything above can be changed from the control center. Profile configuration remains the baseline that `Reset to profile defaults` returns to.

---

## Installation

1. Extract or clone the source repository to a permanent local directory.
2. Add that source directory to the DSH Web profile.
3. Restart DSH Web.

Example from the parent directory containing the plugin source:

```powershell
dsh plugin --profile web add .\dsh-completion-gate
dsh web
```

Then open **Settings → Completion Gate** and review the defaults before relying on strict mode for a production repository.

No dependency installation is required by this plugin.

---

## Updating

Replace the plugin source with the newer source revision and restart `dsh web`.

UI-saved Completion Gate settings are stored separately from the plugin source, so replacing the source directory does not intentionally reset operator preferences. Use **Reset to profile defaults** if you want the new profile defaults instead.

---

## Interaction with model failover / Phoenix

Completion Gate is session/workspace scoped, not model scoped.

If a model fails:

```text
Model A
  ↓ 429 / timeout / provider failure
Phoenix / DSH failover
  ↓
Model B continues same session
  ↓
Completion Gate still owns the same baseline and workspace evidence
```

A replacement model can continue remediation without restarting the task. If the replacement changes code, the change record changes and stale gate evidence is invalidated naturally.

`gateSubagents: false` is recommended with autonomous failover/team orchestration so child jobs are not unnecessarily blocked by the root production-readiness policy.

---

## What happens when the gate blocks

In strict mode DSH receives a steering message similar to:

```text
COMPLETION GATE BLOCKED. Do not claim completion.

- Node test: test failed.
- Changed files not reviewed: src/engine.ts
- Acceptance-criteria evidence is missing.

Fix the failures, review every changed file, then call completion_gate
with action=attest and concrete acceptance-criteria evidence.
```

The agent continues from the existing task/workspace state.

---

## Important limits

### Premature recovery uses a fresh turn

The Premature Stop Guard intentionally uses `agent.followup()` rather than `agent.steer()`. A follow-up lets the naturally stopped turn close and immediately wakes a new turn with the unfinished-work instruction. This composes better with provider retry/failover and avoids same-turn recovery steps that can visibly inject context and then fall idle.

The actual Production Readiness Gate still uses `agent.steer()` because blocking a failed readiness check must veto the current natural completion boundary.

### DSH records assistant output before the final stop hook

DSH can record an `assistant/message` before `agent/turn-stopping` runs. Therefore Completion Gate can prevent the turn from closing and force another step, but it cannot retroactively erase premature prose already emitted by a non-compliant model.

The Premature Stop Guard and system-prompt instructions are intended to make the normal path continue before the task is treated as complete.

### Tests are only as good as the project

Passing tests do not prove correctness. The gate proves that configured checks passed for a specific turn's change record.

### Attestation is structured model evidence

The gate verifies completeness and freshness of the attestation structure; it cannot mathematically prove that an LLM's semantic review was insightful. Independent review plugins, Council, security tooling, and human review still add value.

### Security scanning is intentionally narrow

The built-in scanner catches obvious newly added risky patterns. It is not a comprehensive vulnerability scanner.

### Custom checks execute shell commands

A custom check is operator-controlled code execution on the DSH host. Treat it with the same care as adding a command to a CI configuration.

---

## Recommended configuration for an autonomous developer team

```yaml
enabled: true
mode: strict
gateSubagents: false
preventPrematureStops: true
prematureStopMaxContinuations: 3
autoDetectChecks: true
requireTests: true
requireBuildWhenAvailable: true
requireLintWhenAvailable: true
requireTypecheckWhenAvailable: true
blockNewTodos: true
securityScan: true
requireAttestation: true
gateOnlyChangedWorkspaces: true
```

This leaves implementation freedom to subagents and model failover while keeping one hard readiness boundary at the root agent.

---

## Privacy and security

- Gate reports expose the repository/workspace **basename**, not the absolute local filesystem path.
- Captured command output is sanitized before it is retained or displayed.
- Common credential/token patterns and absolute local paths are redacted from stored failure output.
- Browser settings endpoints require same-origin requests.
- UI-saved settings are persisted host-side; the persistence path itself is not sent to the browser.
- The model cannot add custom check commands through the `completion_gate` attestation tool.

See [SECURITY.md](SECURITY.md) for the concise security model.

---

## License

MIT. See [LICENSE](LICENSE).
