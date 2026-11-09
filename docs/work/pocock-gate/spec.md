# Spec: dsh-completion-gate as an advisory multi-repository completion tracker

Drafted 2026-11-07 from the grill-me decisions of 2026-11-06. Phase frozen at specification: no product code changed while writing it.

## Problem Statement

The gate assumes one repository per session: it takes the session's starting folder, resolves it to a single project root, runs that project's detected checks there, and judges completion against that one root. A session that starts in a scratch folder, in the DSH home, or in repository A while doing its real work in repository B is verified against the wrong tree. The work in B is either invisible or judged by A's tests, so the gate is confidently wrong in exactly the case the owner now works in most.

The gate also asks the model for things it should not: it executes tests, builds, recipes, and temporary probes itself, and it asks for acceptance-criteria evidence that nothing checks. The owner decided the model, not the gate, runs verification, and that a model's report of having run it is believed. What the gate is for is narrower: notice every repository this session changed, remind the model what is unfinished in each, and record the model's claims about files, reviews, documentation, and verification items. It is advice, and it never blocks.

## Solution

Every turn, the gate reads the host's turn-scoped change record, which is its only source of changed paths, resolves each listed file to the repository that owns it, and keeps one completion ledger per repository per session. When the turn is stopping, it sends at most one advisory message. That message lists every repository the session has touched, each changed file's claim state, the code files still unreviewed, whether changed docs were checked, and every verification item the model registered with its state: passed in a run, assumed but not run with the model's reason, or unfinished. The gate runs no verification command, recipe, or probe. It writes no test result and reads no verification output; the only process it may start is Git, for repository discovery, nested HEAD reads, and the local exclude file. It believes what the model attests, and it reopens a repository when the host record adds a path or a recorded file's content changes after that attestation.

Repositories carry a small catalog at `.dsh/verification.json`: the items a session committed to run, each with a comment on what it proves, so a later session can read it, adopt what fits, register what it adds, and leave its own comments behind. The catalog is ignored through the repository's local exclude file, so it never appears in a commit. Session claims live only in the gate's memory, so a host restart forgets them; the catalog survives and the next session is asked again.

## User Stories

1. As a session whose starting folder is not the repository it works in, I want every changed file the host recorder lists to be attributed to the repository that owns it, so the gate judges the tree I actually changed.
2. As a session touching three repositories at once, I want one batched message at the stop that covers all three, so I am not interrupted once per repository or once per file.
3. As the owner, I want the gate to never refuse a write, block a turn, or stop a turn from ending, so a wrong rule can waste a reminder but never control the session.
4. As the owner, I want the gate to execute nothing, so no test, build, lint, recipe, or probe of mine is ever started by a plugin I am not watching.
5. As a model starting work in a repository the session has not touched yet, I want one introduction at the first stop that names the repository, points at its catalog, and asks me to register the verification I will run, so I can do that in one go at the end.
6. As the owner, I want a recorded file another session may have written to arrive as unverified rather than as mine, so the gate asks me about it instead of assuming authorship.
7. As the owner, I want to claim a file or reject responsibility for it, and in either case be believed, so the list reflects reality without the gate auditing me.
8. As the owner, I want a rejected file to leave my list, and an unclaimed file to stay on it, so a concurrent writer's file cannot be quietly dropped and my own file cannot be quietly forgotten.
9. As the owner, I want every changed file in a repository claimed, every changed code file reviewed, every changed doc checked for staleness and bloat, and every registered item passed or assumed before the gate goes silent.
10. As the owner, I want a verification item to be any commitment I make, a test suite, a build, a model check, or a proof, so the gate is not limited to a fixed list of check commands.
11. As the owner, I want an item recorded as passed in a run when I ran it, assumed with my reason when I did not, and unfinished when the run failed or I never reported it, so the gate can tell a promise from a fact.
12. As the owner, I want the assumed state surfaced in every report as a promise that was not run, so I cannot mistake it for a pass.
13. As the owner, I want a recorded change in a repository after my attestation to reopen that repository's files and items, so a stale attestation cannot cover code the gate can see moved.
14. As the owner, I want the attestation to be the last action of a turn, so its claims describe the tree the turn finished with.
15. As the owner, I want every session tracked separately in the same workspace folder, so one session's unfinished work never becomes another session's blocker.
16. As the owner, I want the catalog to live inside each repository and to be ignored by git, so it travels with the tree but never into a commit.
17. As a future session, I want each catalog item to carry a comment on what it proves, so I can decide which items fit my current work before adopting them.
18. As the owner, I want the gate to stay silent when every changed file is claimed, every promise is kept, and every item is passed or assumed.
19. As the person who may leave a session running, I want the advisory reminder bounded per change set, so an ignored reminder cannot wake the session forever.
20. As the owner, I want a blind change source to be reported as blind rather than read as an unchanged turn.
21. As the owner, I want the credential pattern scan kept on added lines, so a hard-coded secret still gets named in the advice.
22. As the owner, I want TODO-marker scanning and the acceptance-criteria evidence field retired, so the gate stops asking for things it does not check.
23. As the operator, I want the settings panel to show only settings that still do something, so no knob lies about behavior.
24. As the operator, I want the subagent gate to stay available and off by default, so the root session remains the final owner.
25. As the operator, I want a session reset command, so a confused session can discard its claims without touching any repository.
26. As a reviewer, I want a test that fails when the batch, the claim belief, the reopen, the once-only introduction, or the non-execution is removed, so each promise is proven rather than described.

## Implementation Decisions

### 1. What the gate is

The gate is an advisory tracker with three jobs: resolve changed files to repositories, record the model's claims and verification reports, and speak once at the stop when something is unfinished. It executes no verification command, recipe, or probe, and reads no verification output. No code path in the plugin may run a command to verify anything. Git may be called, which starts a process, only for repository discovery, nested HEAD reads, and the local exclude file; those calls read and append, and never verify. This retires the machine-check runner, check detection, recipes, the recipe runner, the temporary verifier, and the verification ledger.

### 2. The repository scanner

For each file in the turn's change record, the scanner resolves the absolute path, walks up from it (from the file itself when it is a directory, from its parent otherwise), and takes the nearest ancestor that contains a `.git` entry as the owning repository root. A nested repository or submodule is therefore its own repository. A path outside every repository falls back to the session workspace root, which is also where its catalog lives. The scanner groups files into repositories, preserving the record's path strings, and is used by the stop check, the status action, the register action, and the attest action.

A file is listed at most once per repository. A file that a later turn changes again keeps one entry whose content key is refreshed. A changed file whose recorded path is a directory (a moved submodule pointer) is treated as a file entry keyed by the nested HEAD, reusing the existing content-key behavior.

### 3. Per-session state

All completion state is per session and in memory: for every repository the session has seen, the changed files with their current content keys and claim decisions, the catalog item states, the attestation, and whether the repository was already introduced. A host restart loses all of it; the model is introduced again on the next stop and the catalog remains on disk. Session disposal forgets the session. Nothing is written to a workspace-level file.

Each repository's state carries a digest over its sorted changed paths and their content keys. The attestation is bound to that digest.

### 4. Claims

A changed file starts unclaimed. The model claims it as its own or rejects responsibility for it, and either answer is stored without a check. A claimed file is part of the model's completion obligations; a rejected file leaves this session's obligations; an unclaimed file stays on the list and keeps the gate speaking. Claims are per session, so a file another session also changed is judged by both sessions independently.

### 5. Verification items and the catalog

An item is a commitment the model makes: a test suite, a build, a typecheck, a model review pass, a proof, or anything else that can be named and judged. Each item carries a name, a required `proves` comment stating what passing it establishes, and an optional command for reproducibility. Items are stored in `.dsh/verification.json` inside the repository:

```
{ "version": 1, "items": [ { "id", "name", "proves", "command", "addedAt", "updatedAt" } ] }
```

The id is a stable slug derived from the name at creation and kept across updates. Registering an item with an existing name updates its comment and command and keeps its id. A catalog that cannot be read is reported and never overwritten. The catalog is operator-readable knowledge, not execution input.

Before writing the catalog for the first time in a repository, the gate appends `.dsh/` to that repository's local exclude file when one can be resolved with git. It does not edit the tracked `.gitignore`. A repository without git gets its catalog and no exclusion.

The model reads the catalog through the instructions in `AGENTS.md` and the first-stop introduction, adopts the items that fit the current work by attesting to them, and registers the items it adds. A new session is not forced to adopt anything.

### 6. Attestation

One attestation call covers one repository. It carries the claims for that repository's changed files (each path with a mine or not-mine decision), the reviewed code files, a boolean documentation check, and one state per catalog item. A claimed file is a code file when its path is not documentation by the existing extension and basename rule; every claimed code file must appear in the reviewed code files. The documentation check is required when a changed documentation file is claimed or still unclaimed. An item state is `passed` when the model ran it and it passed, and `assumed` when it did not run it and gave a reason; a failed or unreported item is unfinished.

A malformed call changes nothing and returns the schema error. A well-formed but incomplete call is stored and returns the remaining problems, so the model can correct and attest again. The gate never verifies the claims, never checks that a command ran, and never compares the report with tool events.

Attestation is the last action of a turn by instruction. Code that changes after it is handled by reopening, not by asking the model to attest mid-turn.

### 7. Reopening

At every evaluation the gate refreshes the content key of every changed file it knows in a repository and recomputes the repository digest. When the digest differs from the attested digest, that repository reopens: every file claim and every item state is cleared and the attestation is dropped. The model must claim, review, and attest again. This is the whole rule, and it does not weaken for a change to a recorded path outside the current turn's record. It is bounded by the change source: a path the host record omits cannot reopen anything, which Decision 14 states as a limit.

### 8. The advisory message

The gate speaks only when the turn is stopping. It builds one message covering every repository the session has touched that still has unfinished work. A repository appears in that message with its label and root, the files by claim state, the code files not yet reviewed, the documentation check when it is missing, every catalog item with its state (passed, assumed with its reason, or unfinished), and whether the attestation is missing or stale. A repository seen for the first time in this session gets one introduction paragraph, once. A repository with nothing unfinished contributes nothing.

The message is delivered with a steer, the same seam the gate uses today: it queues one more model step in the same turn before the turn boundary commits, and it never blocks a write or a tool call. After the bound is reached the gate sends no further steer; the turn closes only at a later stop boundary where no new steering is queued. The message says it is advice and names the next action: read the catalog, register what is missing, claim or reject every file, review the code, check the docs, then attest. It never says BLOCKED and never claims a check failed.

The gate sends at most one such message per stop. The number of messages per change set is bounded by the existing nudge limit: after that bound the gate stays silent until the change set changes. A bound of zero means the gate never speaks. This silence-after-the-bound policy is a design choice, not an owner directive: today's gate switches to a shorter still-blocked reminder instead of stopping.

The gate reports an undetermined change set, in one short message under the same bound, when the recorder service is absent, when the session is known to be excluded from recording, when an announced record cannot be read, when the record is truncated, or when the turn exceeds the changed-file bound. An ended session the recorder covers with no announcement is read as unchanged and produces no message. The host's silent failure cases stay an accepted false-negative limit.

The message also reports added-line credential-pattern hits for the turn when the security scan is enabled. A hit is advice about the diff, not a claim the model can answer, and it keeps the gate from silence for that turn.

### 9. The tool surface

The `completion_gate` tool keeps three actions: `register`, `attest`, and `status`. `register` and `attest` require a `repository_root` argument, which must resolve to a repository root this session has seen (the workspace fallback included); the gate refuses any other root. `register` writes catalog items for that repository and returns the catalog path and item ids. `attest` records that repository's claims, reviews, documentation check, and item states, and returns the current report. `status` returns the per-repository report for the session without speaking and without running anything. The `run`, `recipe`, and `temporary_verify` actions are removed. The `/gate` and `/gate-status` commands show the same report; `/gate-reset` clears this session's claims and attestations; `/gate-override` is removed because nothing blocks.

### 10. Settings

The settings that survive are `enabled`, `gateSubagents`, `preventPrematureStops`, `prematureStopMaxContinuations`, `securityScan`, `maxChangedFiles`, and `verificationNudgeLimit`. The mode selection is removed because the gate is advisory only. The machine-check keys, the recipe keys, the temporary-verifier key, the command timeout, the stored-output bound, the custom checks, the attestation toggle, and the changed-workspace toggle are removed. The premature-stop guard keeps its current behavior. The schema version becomes 2, so a saved schema-1 file is ignored and the profile configuration applies until the next save. The bundle patch drops the retired keys. The control-center panel shows the surviving settings, the per-repository state for every session, and a pending count; it no longer shows check tables, recipes, custom checks, or a verification-source card.

### 11. Instructions the model reads

The fixed system-prompt paragraph is rewritten to say: register the verification you commit to in each changed repository's catalog, run it yourself, claim or reject every changed file, review every changed code file (a separate reviewer subagent is the recommended pattern), check changed docs for staleness, bloat, and conflicting information, then attest last; the gate runs nothing and believes you. The `AGENTS.md` Completion section is rewritten with the same instructions and the assumed state, and points at the catalog path and the commands.

The per-repository introduction at the first stop carries the same call to action in one short paragraph.

### 12. Retired machinery

The machine-check runner, check detection, recipe detection, the recipe runner, the temporary verifier, the verification ledger, the custom checks, the acceptance-criteria field, the TODO scan, the mode switch, the override, and their tests are removed. The credential pattern scan, the added-line diff read, the content key, the change digest, the turn tracker, and the premature-stop guard remain. No import may remain from a removed module.

### 13. Package surface

The package version becomes 0.2.0. The exports list drops the removed modules and adds the scanner, catalog, and state modules when those are separate. The check script lists every remaining source file. The description, keywords, and README describe the advisory tracker.

### 14. Accepted limits

The recorder is the source of truth and has limits the gate cannot fix. A session's snapshot covers the repository that holds its working directory. A file in a sibling repository is listed only when a file tool edits it, and a shell edit there is never listed. Ignored paths are listed only when a file tool captures them. A path already dirty at turn start is part of the baseline and is not listed. Nested repositories are listed as their directory path, so their inner files are unseen. A missing record after a turn ends is read as no change. A session's record is per session but author-blind, so a recorded file may have been written by another process. A subagent session is not recorded at all, so enabling the subagent gate makes the child report an undetermined set. The gate believes the model, so a false claim is accepted by design. Reopening sees only paths the recorder lists; a change it omits cannot reopen an attestation. A host restart loses session claims and attestations but not catalogs. These limits are stated in the README, not hidden.

## Directive Table

| The owner's words | Current artifact | Where this design implements it |
| --- | --- | --- |
| "A scanner will detect whether changed files belong in repos, and prompt models to register them." | `lib/index.js:250-258` resolves one root from the session cwd; `lib/runner.js:9` `projectRoot` | Decisions 2 and 8: per-file repository resolution, once-only introduction, register prompt |
| "Remember everything in my dsh completion gate is advisory (prompting model to do stuff), never strictly enforced (because the rules could be wrong and situation does not apply)" | `lib/index.js:547` advisory short-circuits before any message; `lib/core.js:12` default mode strict | Decisions 1 and 8: advisory only, one batched message, no block, no mode |
| "A repository is prompted about once, the first time the session sees it." | no concept; `lib/index.js:196-203` session state only | Decision 3 and 8: introduced flag per repository per session |
| "the gate shouldn't be running any tests. ask the model to do so. keep track of whether tests are properly run and remind model if it hasn't (however the completion gate is nagging the model today)" | `lib/runner.js:27-42` runs detected checks; `lib/index.js:381` `runMachineGate` | Decisions 1, 6, 8: no execution, item states from the model, bounded reminders |
| "I only fear that a model forgets. I don't worry that a model can lie. If model says it has run a test or changed a file, the gate should believe it." | `lib/core.js:72-73` stores any evidence text without checking | Decisions 4 and 6: claims and item states stored as reported |
| "The gate should mark that a file changed, with unverified actor. It can ask if the model changed it. If the model attests to it, the gate believes it (and if the model rejects responsibility, the gate believes it too)." | `lib/core.js:73` requires every changed file in `reviewed_files` but has one actor | Decisions 4 and 6: unclaimed, mine, not-mine, all believed |
| "to avoid it being too noisy, the gate shouldn't interject with a question the moment a file changes, but rather having that unverified actor status being batched into unfinished tests as requirement for completion, so the model can do it all it one go in the end." | `lib/index.js:533-565` speaks only at the stop, per turn's single root | Decision 8: one batched message at the stop across repositories |
| "Anything can count as 'tests' and verification. I plan to make the completion gate general purpose (later on it will include state charts, modeling with TLA+, formal verification etc. and so on)." | `lib/verification.js:14` fixed source list; `lib/recipe.js:50-181` fixed toolchains | Decision 5: model-named items with any name and comment |
| "the catalog sits in the repository and is ignored by git" | `lib/recipe.js:13` `.dsh/environment.json`, written only on demand | Decision 5: `.dsh/verification.json`, local exclude entry |
| "any change in the repository after attestation reopens its items" and "The attestation should always be the last thing ever done." | `lib/index.js:306-315` builds the path and content-key list; `lib/changes.js:91-130` reads bytes and nested HEAD; `lib/changes.js:46-53` hashes; `lib/ledger.js:41-55` compares freshness | Decisions 6 and 7: digest-bound attestation over recorded paths and their content keys; the narrower reach is a stated limit in Decision 14 |
| "it can attest that that test / rerun is 'not run, but assumed to pass' , and the gate should believe that (so there is an extra state now)" | no assumed state; `lib/core.js:73` accepts any evidence | Decisions 5, 6, and 8: assumed state with reason, surfaced in the message |
| "I want the model to honestly attest it has properly run a code review on each edited code file. I personally usually let a subagent ... to do code review fix loops with main agent. The completion gate can remind the model of this rule." | `lib/core.js:72-73` reviewed_files list; `lib/index.js:711` system prompt | Decisions 6 and 11: per-code-file review list, subagent reminder |
| "As for docs, I want the model to honestly attest the docs are not stale, bloated, or containing conflicting information (and the gate should remind model of this). No extra subagent run is needed." | no dedicated documentation check; `lib/changes.js:21-40` only classifies doc paths | Decisions 6 and 11: documentation check per repository, prompt wording |
| "in the same workspace folder, there could be multiple sessions working, so I want the gate to track per session instead of letting one session influence another." | `lib/index.js:196-203` state map per session; `lib/changes.js:133-167` tracker per session | Decision 3: all completion state per session |
| "I want AGENTS.md to instruct new sessions to be able to read it and adopt tests from previous sessions that it deems appropriate for its current work, so ideally sessions should also leave comments on what each test is for" | `AGENTS.md:133` completion paragraph | Decisions 5, 10, and 11: catalog comments, adoption instruction |
| "AGENTS.md should be reinforced with how to use completion gate: how to register what tests it will run, and how to attest what tests it has run (and the gate should believe the model)." | `AGENTS.md:133` | Decision 11: rewritten Completion section |
| "the credential scan stays while TODO-marker scanning and the acceptance-criteria evidence field retire" | `lib/core.js:69-71` scans; `lib/core.js:73` criteria | Decisions 8 and 12: security scan stays, TODO scan and criteria removed |
| "tool keeps register, attest, status and retires the three command-running actions" | `lib/index.js:617` action enum | Decision 9: three actions only |
| "catalog at .dsh/verification.json, kept out of git through the repository's local exclude file" | `lib/recipe.js:13` different path and file | Decision 5: exact path and local exclude |
| "session state lives in gate memory, so a host restart loses it and the session is asked again while the catalog survives" | `lib/index.js:185-203` in-memory state | Decision 3: in-memory claims, on-disk catalog |

## Testing Decisions

Tests exercise behavior through the plugin's own seam: a stub host that feeds session events and a change record, then reads what the gate stored and what message it sent. The suite keeps the existing node:test structure and file naming. A test should fail when the behavior it names is removed.

The suites cover, at minimum: repository resolution for a file inside the session root, a sibling repository reached by a relative path, an absolute path in another repository, a nested repository, and a path outside every repository; one repository entry per file across turns; the introduction appearing once and only once; claims of mine, not-mine, and unclaimed; a rejected file leaving the list; the digest reopening claims and item states after a content change; an attestation stored without any verification of its claims; the assumed state requiring and carrying a reason; the batch listing every repository in one message; silence when everything is attested; the nudge bound silencing the gate and zero disabling it; the undetermined message for an absent recorder, an excluded session, an unreadable announced record, and a truncated record, and silence for an ended covered turn with no announcement; the repository selector refusing an unknown root; a recorded file's content change reopening a repository and a path the record never lists staying absent; the credential hit appearing in the message; catalog creation, merge by name, corrupt-catalog refusal, and the local exclude append; the settings schema-2 read and the retired keys being absent; the package version and exports.

Tests must not shell out to run project checks, because the plugin no longer runs them; a test that invokes a check would be testing a removed behavior. The temporary-verifier, recipe, ledger, machine-check, and custom-check test files are removed with their subjects. Tests that asserted the old stop behavior are rewritten to the advisory message.

Verification commands: `npm run check && npm test`. A stub-host probe under `~/Trash/pocock-gate/` runs the service against a fake change record with two repositories and prints the message and per-repo status; it is a probe, not a suite.

## Out of Scope

- Running any verification, test, build, lint, recipe, or probe. The gate must not regain an execution path.
- Strict enforcement, blocking, overrides, and completion-claim phrase matching.
- Formal verification, state charts, or TLA+ tooling; the item model is general enough to hold them later.
- Changing the host change recorder or its coverage.
- A workspace-level session state file or cross-session completion state.
- Live activation (a host restart) inside the implementing session; the restart that loads the new code is the owner's act after the commit.

## Further Notes

The introduction and the message share one call to action so a first stop never speaks twice. The gate's silence is the only signal of completion; there is no PASS banner to mistake for verification.

The catalog is a knowledge file. The gate reads it, merges into it, and never executes anything it contains. A future session may adopt an item by attesting to it, ignore it, or register a new one; nothing expires automatically.

Parallel sessions in one folder remain author-blind: a file written by another session lands in this session's record as unclaimed. The model's claim or rejection is the attribution, and the gate believes it. That is the deliberate trade in the decision table, and the README states it.

## Deliverables

- The kata spec (this issue) and its child tickets in project `personal`.
- The rewritten plugin in `/home/wilder/dsh-test/dsh-completion-gate` at version 0.2.0.
- The rewritten Completion section of `/home/wilder/.dsh/AGENTS.md`.
- The updated `README.md`, `CHANGELOG.md`, `SECURITY.md`, `cordis.patch.yml`, and `docs/` in the plugin repository.
