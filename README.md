# dsh-completion-gate

Completion Gate is a DeepSeek Harness plugin that tracks every file a session changes, resolves each changed file to the repository that owns it, and sends the model one advisory message per user prompt naming the work still unfinished in each repository. It is a reminder, not a check: it executes no test, build, lint, recipe, or probe, and it believes what the model reports about its own work.

The plugin also keeps the Premature Stop Guard, which recovers a natural stop that clearly leaves work pending by scheduling a fresh follow-up turn.

---

## Why this plugin exists

A session often starts in one folder and works in another. The starting folder may be a scratch directory, the DSH home, or repository A while the real work happens in repository B. A completion gate that resolves one project root from the starting folder verifies the wrong tree in that case: the work in B is invisible or is judged by A's checks.

The earlier design also ran verification itself. It detected test, build, lint, and typecheck commands, executed them, generated temporary probes, and judged completion from their output. That put a plugin in charge of code execution the owner did not ask it to perform.

The operator decided two things. The model runs verification, not the gate. And the gate believes the model's report of what it ran. What the gate records is a set of completion commitments: which changed files belong to this session, which code files were reviewed, whether changed documentation was checked, and the state of every verification item the session committed to.

Completion Gate is advisory. It never refuses a write, never blocks a tool call, and never stops a turn from ending. It can waste a reminder when its rules are wrong, and that is the whole cost of a mistake.

---

## Core behavior

1. The gate reads the host's turn-scoped change record. The record comes from `@deepseek-ai/dsh-workspace-changes`, which snapshots the working tree at turn start and turn end and diffs the two snapshots.
2. The scanner resolves every listed path to the repository that owns it.
3. The gate merges the result into one ledger per session per repository.
4. When the model tries to end the turn, the gate speaks at most once for that user prompt. The message lists what each repository still owes. A repository with nothing unfinished contributes nothing.

Repository discovery walks `.git` entries on the filesystem and starts no process. The gate starts Git only to read a nested repository's HEAD and to resolve the local exclude file.

### The repository scanner

For each changed path, the scanner walks up from the file, or from the recorded directory itself, and takes the nearest ancestor that contains a `.git` entry as the owning repository root. A nested repository or submodule is therefore its own repository. A path outside every repository falls back to the session's workspace root, which is also where its catalog lives.

A file is listed once per repository. When a later turn changes the same file again, its one entry is refreshed rather than duplicated. A changed path that is a directory, such as a moved submodule pointer, is treated as a file entry keyed by the nested HEAD.

### Per-session ledger

All completion state is held per session and in memory. For every repository the session has seen, the gate stores:

- the changed files with their current content keys;
- each file's claim and reviewed state;
- the state of each catalog item, including items this session marked unrelated;
- the attestation, bound to a digest of the changed paths and their content keys;
- whether the repository was already introduced to the session.

A host restart loses all of it. The next session is introduced to each repository again, and the catalog remains on disk. Session disposal forgets the session. Nothing is written to a workspace-level completion file.

---

## Claims

A changed file starts unclaimed. The model claims it as its own or rejects responsibility for it, and either answer is stored without a check.

- `mine` puts the file in this session's completion obligations.
- `not-mine` removes it from those obligations.
- unclaimed keeps the file on the list and keeps the gate speaking.

Claims are per session. When two sessions change the same file, each session judges it independently.

Review is a second state on every changed file. Every file starts unreviewed. The attestation marks the code files it lists and the documentation files it covers as reviewed. A rejected file leaves the review obligation with the claim. A claimed code file that stays unreviewed, or a changed documentation file the session has not rejected and not checked, keeps the gate speaking.

---

## The verification catalog

Each repository carries a small catalog at `.dsh/verification.json`. It holds the verification items a session committed to run, so a later session can read it, adopt the items that fit, register what it adds, and leave its own comments behind.

```json
{
  "version": 1,
  "items": [
    {
      "id": "unit-tests",
      "name": "Unit tests",
      "proves": "The scanner resolves paths and the tracker keeps one entry per file.",
      "command": "npm test",
      "addedAt": "2026-11-08T04:00:00.000Z",
      "updatedAt": "2026-11-08T04:00:00.000Z"
    }
  ]
}
```

Each item has a name, a required `proves` comment stating what passing it establishes, and an optional command for reproducibility. The `id` is a stable slug derived from the name when the item is created and is kept across updates. Registering an item with an existing name replaces its `proves` comment, keeps its id, and sets its command: an omitted command removes the stored one.

The command field is documentation. The gate never runs it.

The catalog is operator-readable knowledge, not execution input. The gate reads it, merges into it, and never executes anything it contains.

Before writing a catalog, the gate appends `.dsh/` to that repository's local exclude file once, when Git can resolve one. The tracked `.gitignore` is never edited. A repository without Git gets its catalog and no exclusion.

A catalog that cannot be read is reported and never overwritten. An item is only judged against the catalog the repository holds at that moment.

### Item states

- `passed`: the model ran the item and it passed.
- `assumed`: the model did not run it and gave a reason. The reason is required. The report always shows an assumed item as a promise, not a pass.
- `unrelated`: the item does not bear on this session's work. It is left out of the advisory message so it does not nag this session again. The mark survives a reopening, and the status report still lists the item.
- unstated: the item is unfinished. A failed item is simply not marked passed, so it stays unfinished.

---

## Attestation

One attestation call covers one repository. The model calls the `completion_gate` tool with `action: "attest"` and these fields:

- `repository_root`: the repository to attest. It must be a repository this session has changed, or the session's workspace root.
- `claims`: one entry per changed file, with `path` and `decision` set to `mine` or `not-mine`.
- `reviewed_code_files`: the changed code files the session claims as its own and has reviewed.
- `docs_checked`: true when the session checked every changed documentation file it has not rejected for staleness, bloat, and conflicting information.
- `items`: one state per catalog item, with `id` and `state` set to `passed`, `assumed`, or `unrelated`. An assumed item also carries a `reason`.
- `summary`: an optional free-text note.

A claimed file is a code file when its path is not documentation by the extension and basename rule. Every claimed code file must appear in `reviewed_code_files`. Every changed file starts unreviewed, and a file the latest attestation does not cover stays unreviewed.

A malformed call changes nothing and returns the schema error. A call the gate refuses changes nothing either and says why: a path that is not a changed file, an item id that is not in the catalog, a changed file it cannot read, or a nested repository with no readable HEAD. A well-formed call that leaves work undone is stored and returns the remaining problems, so the model can correct it and attest again. The gate never verifies the claims, never checks whether a command ran, and never compares the report with tool events.

Attestation is the last action of a turn by instruction. Code that changes after it is handled by reopening, not by asking the model to attest mid-turn.

### Reopening

At every evaluation, the gate refreshes the content key of every changed file it knows in a repository and recomputes the repository digest. When the digest differs from the attested digest, the repository reopens.

A reopening clears every file claim, every reviewed state, and every item state except an item marked unrelated, and it drops the attestation. The model must claim, review, and attest again.

Reopening is bounded by the change source. A path the host record omits cannot reopen anything, which is one of the accepted limits below.

---

## The advisory message

The gate speaks only when the model tries to end a turn, and at most once per user prompt. It takes the first attempt of the prompt that has something to say and stays silent at every later attempt.

The message covers every repository the session has touched that still has unfinished work. A repository appears with its label and root, the changed files grouped by claim, the code files not yet reviewed, the documentation check when it is missing, every catalog item with its state, and whether the attestation is missing or stale. An item marked unrelated is left out. A repository seen for the first time in this session gets one introduction paragraph that names the repository, points at its catalog, and asks the model to register the verification it will run. The introduction appears once.

The message is delivered with `agent.steer`, which queues one more model step in the same turn before the turn boundary commits. It never blocks a write or a tool call. After that one steer the gate sends no further message until another real user message arrives.

The message says it is advice and names the next action: read the catalog, register what is missing, claim or reject every file, review every changed code file the session claims, check every changed document it has not rejected, then honestly attest. It never says BLOCKED and never claims a check failed.

A new real user message re-arms the advisory. The gate's own steer, the premature-stop recovery, and a changed change set do not.

### When the change set cannot be determined

The gate reports an undetermined change set, in one short message under the same one-per-prompt rule, when:

- the recorder service is absent;
- the session is known to be excluded from recording;
- an announced record cannot be read;
- the record is truncated;
- the turn exceeds the changed-file bound.

An ended session the recorder covers with no announcement is read as unchanged and produces no message. The host's silent failure cases stay an accepted false-negative limit.

### Security-scan hits

When the security scan is enabled, the message also reports added-line security-rule hits for the turn. A hit is advice about the diff, not a claim the model can answer. It rides the one message for the prompt, and a hit recorded after that message waits for the next user prompt. Only the rule message is shown, never the matched text. A changed file whose added lines could not be read is named so the scan's gap is visible.

### The Premature Stop Guard

The plugin keeps the Premature Stop Guard. When a model naturally stops while its own latest output says work is pending, the guard schedules a fresh follow-up turn with `agent.followup`. Recovery is bounded by `prematureStopMaxContinuations`, so repeated recovery turns cannot loop forever.

The guard is separate from the advisory. It reads the model's stop text, not changed files, and it never blocks.

---

## Settings

Six settings remain.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for repository tracking, premature-stop recovery, and the advisory message. |
| `gateSubagents` | `false` | Include subagent stop boundaries. Off is recommended because the recorder does not record subagent sessions. |
| `preventPrematureStops` | `true` | Recover a natural stop that clearly says work is still pending by scheduling a fresh follow-up turn. |
| `prematureStopMaxContinuations` | `3` | Safety cap across one consecutive premature-stop recovery chain, from 0 to 20. |
| `securityScan` | `true` | Scan the turn's added lines for high-confidence credential and unsafe-code patterns. |
| `maxChangedFiles` | `500` | Safety bound on the changed-file inventory, from 10 to 5000. A turn over the bound is reported as an incomplete change set. |

The saved settings file uses schema version 2. A schema-1 file is ignored and the profile configuration applies until the next save. The settings file path is not returned to the browser.

The machine-check keys, the recipe keys, the temporary-verifier key, the command timeout, the stored-output bound, custom checks, the attestation toggle, the changed-workspace toggle, the TODO-marker key, and the nudge limit are gone. The mode selection is gone because the gate is advisory only.

---

## Commands

### `/gate` and `/gate-status`

Show the session report: every repository this session changed, with each file's claim and reviewed state, the catalog items and their states, the attestation state, and the remaining problems. Neither command starts a check.

### `/gate-reset`

Clears this session's claims, item states, attestations, and premature-stop bookkeeping. No repository, catalog, or file is touched.

### `completion_gate` tool

The tool has three actions.

- `register` writes items into one repository's catalog and returns the catalog path, the item ids, and whether Git will ignore the catalog. It starts no check.
- `attest` records one repository's claims, reviews, documentation check, and item states, then returns that repository's report. It starts no check.
- `status` returns the per-repository report for the session. It starts no check and sends no message.

`register` and `attest` both require `repository_root`.

Example attest call:

```json
{
  "action": "attest",
  "repository_root": "/home/wilder/dsh-test/dsh-completion-gate",
  "claims": [
    { "path": "README.md", "decision": "mine" },
    { "path": "lib/index.js", "decision": "mine" }
  ],
  "reviewed_code_files": ["lib/index.js"],
  "docs_checked": true,
  "items": [
    { "id": "unit-tests", "state": "passed" },
    { "id": "manual-smoke", "state": "assumed", "reason": "The CLI has no entry point to smoke test in this environment." }
  ]
}
```

---

## Control Center

Open **Settings → Completion Gate**.

The panel edits the six settings and shows the runtime state: one row per session, one block per repository with claim counts, every changed file's claim and reviewed state, catalog item states, and whether the attestation is current, stale, or missing. It also shows the pending repository count.

`Save settings` applies changes immediately and persists them across `dsh web` restarts. `Reset to profile defaults` removes the saved overlay and returns to the active profile's configuration.

The conversation header shows a compact status:

```text
Gate · 2 pending
Gate · off
```

---

## Important limits

### Accepted limits of the change recorder

The recorder is the source of truth, and it has limits the gate cannot fix.

- A session's snapshot covers the repository that holds its working directory. A file in a sibling repository is listed only when a file tool edits it. A shell edit in a sibling repository is never listed.
- Ignored paths are listed only when a file tool captures them.
- A path already dirty at turn start is part of the baseline and is not listed.
- Nested repositories and submodules are listed as their directory path, so their inner files are unseen. A moved HEAD is seen.
- A nested repository whose HEAD cannot be read is named at the stop. When it has a previously read HEAD, that value stands in, its attestation stays current for the recorded commit, and the gate says it could not check the current commit. When it has never been read, attestation of that nested repository is refused until its HEAD reads again.
- A missing record after a turn ends is read as no change. The host also writes no record when recording fails, when the turn-start baseline fails, and when the turn has no tool result. The gate cannot tell those cases apart.
- A session's record is author-blind. A listed file may have been written by another process or another session. The model's claim or rejection is the attribution, and the gate believes it.
- A subagent session is not recorded at all. With `gateSubagents` enabled, the child reports an undetermined change set.
- The gate believes the model, so a false claim is accepted by design.
- Reopening sees only the paths the recorder lists. A change it omits cannot reopen an attestation.
- A host restart loses session claims and attestations. The catalog survives in the repository.
- A turn that changes more files than `maxChangedFiles` is reported in the advisory as an incomplete change set, because the complete set cannot be determined.

These limits are stated here rather than hidden. A wrong limit can cost a reminder; it cannot block a session.

### Recovery uses a fresh turn

The Premature Stop Guard uses `agent.followup`, not `agent.steer`. The follow-up lets the naturally stopped turn close and wakes a new turn with the unfinished-work instruction.

---

## Interaction with model failover / Phoenix

Completion Gate is session scoped, not model scoped. When a provider fails and a replacement model continues the same session, the session's ledger stays as it was: the same changed files, claims, reviews, item states, and attestation.

If the replacement model changes code, the recorded content changes and the repository reopens on the next evaluation, so the attestation cannot cover the old tree. `gateSubagents: false` is recommended with autonomous failover and team orchestration, so child jobs are not asked to report a change set the recorder does not cover.

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

Then open **Settings → Completion Gate** and review the defaults.

No dependency installation is required by this plugin.

## Updating

Replace the plugin source with the newer source revision and restart `dsh web`.

UI-saved settings are stored separately from the plugin source, so replacing the source directory does not reset operator preferences. Use **Reset to profile defaults** when you want the new profile defaults instead.

---

## Privacy and security

- The settings API accepts same-origin browser requests only.
- UI-saved settings are persisted host-side, and the persistence path is not returned to the browser.
- Reports name repository roots and changed file paths because the model needs them to do the work.
- Security-scan hits name the rule and the count, never the matched text.
- The catalog is a knowledge file, not an execution input.

See [SECURITY.md](SECURITY.md) for the concise security model.

---

## License

MIT. See [LICENSE](LICENSE).
