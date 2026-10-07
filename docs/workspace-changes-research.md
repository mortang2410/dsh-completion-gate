# `@deepseek-ai/dsh-workspace-changes` research

## Summary

`@deepseek-ai/dsh-workspace-changes` records which files each top-level turn changed and serves that list through the Host service `workspaceChanges`. It is the authoritative per-turn changed-file source for this plugin's problem statement: the summary is built from git working-tree snapshots taken at turn start and turn end, so a file that was already dirty before the turn is part of the baseline and is not attributed to the turn.

Two findings affect how `dsh-completion-gate` should consume it:

1. The service is not a query-by-turn API. `summary(sessionId, seq)` is keyed by the **sequence number of the `workspace/changes` Session event** (`seq`), which the caller must obtain from the event envelope (`event.seq`). There is no method to ask "give me the latest summary for turn N".
2. The README's design-note link points at `.agents/notes/implemented/feature/2026-09-11-turn-changed-files-card.md`, which now returns HTTP 404 on `master`. The note was archived to `.agents/notes/archived/feature/2026-09-11-turn-changed-files-card.md`. Upstream `master` already corrected the link; the installed 0.2.0-rc.2 copy still has the stale one.

## Sources read

Primary, upstream `deepseek-ai/deepseek-harness`, branch `master`:

- Package README: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/deliverables/workspace-changes/README.md (raw: https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/deliverables/workspace-changes/README.md)
- Design note: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/archived/feature/2026-09-11-turn-changed-files-card.md
- Persistence-change record for the event: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/persistence-changes/2026-09-14-workspace-changes-event.md

Local installed copy, version 0.2.0-rc.2:

- `/home/wilder/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-workspace-changes/` (README.md, lib/index.js, lib/types/*.d.ts, lib/types/*.js)
- `/home/wilder/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/types/` (types.d.ts, index.d.ts, known-event-types.js)
- `/home/wilder/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-deliverables/lib/` (the shipped consumer)

The local and upstream READMEs are byte-identical except for two hunks in the internals/details block: upstream adds a "Runtime invariant" paragraph and, importantly, rewrites the design-note link from `implemented/` to `archived/`.

## Question 1: What the recorded summary contains per file

Per-file shape is `WorkspaceChangedFile` (`lib/types/types.d.ts:4-21`):

| Field | Type | Meaning | Source |
|---|---|---|---|
| `path` | `string` | "Path relative to the Session working directory, or an absolute Host path outside it." | `types.d.ts:6` |
| `display` | `string` | "Sort key and label: the relative path inside the working directory, a `../` path for repository files above it, a `~` path under the home directory, otherwise the absolute path. Always slash-separated." | `types.d.ts:12` |
| `added` | `number` | "Lines added; zero for a binary or oversized file." | `types.d.ts:14` |
| `deleted` | `number` | "Lines deleted; zero for a binary or oversized file." | `types.d.ts:16` |
| `binary` | `true` (optional) | "Present when git reported the file as binary, or when a captured side holds a NUL byte." | `types.d.ts:18` |
| `oversized` | `true` (optional) | "Present when a captured side exceeded the plugin's `maxFileBytes`; the file is listed without counts or comparison." | `types.d.ts:20` |

The line-count fields are `added` and `deleted`. The path fields are `path` (durable, used to open the file) and `display` (label and sort key). README:48 states the same: "Each file carries a durable `path` — relative to the working directory inside it, absolute elsewhere — and a `display` path used for ordering and labels".

The enclosing summary is `WorkspaceChangesSummary` (`types.d.ts:23-41`):

| Field | Type | Meaning | Source |
|---|---|---|---|
| `turn` | `number` | "The turn whose file changes this summary describes." | `types.d.ts:25` |
| `cwd` | `string` | "The Session working directory `path` values are relative to." | `types.d.ts:27` |
| `files` | `WorkspaceChangedFile[]` | "Changed files in `display` order, capped at the plugin's `maxFiles`." | `types.d.ts:29` |
| `total` | `number` | "Complete changed-file count, including files omitted by the cap." | `types.d.ts:31` |
| `added` | `number` | "Lines added over every changed file, including files omitted by the cap." | `types.d.ts:33` |
| `deleted` | `number` | "Lines deleted over every changed file, including files omitted by the cap." | `types.d.ts:35` |
| `snapshot` | `{ before: string; after: string }` (optional) | "Git tree ids of the turn-start and turn-end snapshots; absent when no snapshot was taken." | `types.d.ts:37-40` |

The paired comparison type `WorkspaceFileDiff` is a discriminated union (`types.d.ts:56-82`): `kind: 'text'` with `path`, `display`, `before: boolean`, `after: boolean`, `hunks: WorkspaceDiffHunk[]`, `coarse: boolean`; `kind: 'binary'` with `path`, `display`; `kind: 'oversized'` with `path`, `display`. A hunk is `{ oldStart, oldLines, newStart, newLines, lines: string[] }` with three context lines (`types.d.ts:43-54`).

Note that `summary()` is synchronous and returns the whole file list at once (`types.d.ts:91`); `diff()` is async and takes an `index` into that list (`types.d.ts:101`).

## Question 2: What `seq` is, and how a consumer obtains it

`seq` is the Session event sequence number of the `workspace/changes` event, not the turn number.

The event type is declared by this plugin into the Session event map (`types.d.ts:103-114`):

```ts
'workspace/changes': {
    turn: number;
};
```

Every Session event carries its sequence number on the envelope (`dsh-session/lib/types/types.d.ts:489-496`):

```ts
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
    [K in SessionEventType]: {
        type: K;
        /** Monotonic sequence number within the session. */
        seq: SessionSeq;
```

`SessionSeq` is `BrandedNumber<'SessionSeq'>` (`dsh-session/lib/types/types.d.ts:13`), a non-negative safe integer admitted by the owning log.

The plugin appends the event and stores the summary under the returned `event.seq` (`lib/index.js:897-910`):

```js
const event = this.session.append("workspace/changes", { turn: state.turn });
const kept = sorted.slice(0, this.env.maxFiles);
this.records.set(event.seq, { summary: { ... }, sources: ... });
```

`Session.append` returns the logged event, "its assigned `seq`/`time` plus the SNAPSHOT of `data`" (`dsh-session/lib/types/index.d.ts:228-230`).

README:48 states the contract exactly:

> "The `workspace/changes` event carries only the turn number; `ctx.workspaceChanges.summary(sessionId, seq)` returns the summary the event with that sequence announced, or undefined once the Session is disposed or when this Host process never recorded it."

**How a consumer obtains the seq.** There is no accessor for "latest seq of turn N" on the `workspaceChanges` service; the interface exposes only `summary(sessionId, seq)` and `diff(sessionId, seq, index, signal)` (`types.d.ts:84-102`). The consumer must read the event envelope's `seq` itself. The shipped Web consumer does exactly this (`dsh-client-ui-deliverables/lib/client.js:1187-1190`):

```js
if (match.event.type === "workspace/changes") return {
    ...context.state,
    changes: { seq: match.event.seq }
};
```

Its state type is named "The latest `workspace/changes` announcement of one Turn; the Host serves its summary by this sequence." (`dsh-client-ui-deliverables/lib/types/client/turn-deliverables.d.ts:14-17`). The Host route then passes `seq` through as a query parameter (`dsh-client-ui-deliverables/lib/index.js:169-185`).

Practical consequence for `dsh-completion-gate`: to get the current turn's summary, a Host-side plugin subscribes to the Cordis `session/event` event, keeps the highest `event.seq` seen for `event.type === "workspace/changes"` whose `event.data.turn` equals the turn in question, and calls `summary(sessionId, thatSeq)`. Even though the recorder keeps a record per appended event, the effective card per turn is the latest announcement for that turn.

**Multiple announcements per turn.** The recorder appends inside the turn on `agent/turn-stopping` and may append again after `turn/end` (`lib/index.js:1092`, `lib/index.js:1085-1087`; README:58: "`turn/end` records again only when tool results settled after the last record attempt"). README:58 says "an empty list after an earlier record supersedes it", and `types.d.ts:107-108` says "The latest event for one turn replaces earlier ones." Observed in code: the recorder does **not** delete the earlier record (`grep -c "records.delete" lib/index.js` returns 0; only `this.records.clear()` on disposal at `lib/index.js:783`). So both seqs remain individually queryable via `summary()`, and "replaces" means the client should treat the latest announcement as authoritative, not that the earlier one is unreachable. This distinction is an inference from the code (`lib/index.js:897-911` plus the absence of a delete), not a documented statement.

## Question 3: Documented coverage limits

**Subagent sessions.** Not recorded. README:44: "Every Session with a working directory and no subagent origin is recorded; subagent Sessions are not." The code filters on both origin and depth (`lib/index.js:985-986`):

```js
function eligible(session) {
    const { cwd, origin, delegationDepth } = session.header;
    return origin === "subagent" || (delegationDepth ?? 0) > 0 ? void 0 : cwd;
}
```

The README mentions only the subagent origin; the code additionally excludes any session with `delegationDepth > 0`. That extra condition is visible in code but not stated in the README.

**Working directory outside a git repository.** No snapshot is taken; only file-tool edits are listed. README:44: "A working directory outside any git repository takes no snapshots." README:93: "A working directory outside any git repository lists file-tool edits only, so shell edits are missing from its card". `git.d.ts:61`: "A directory outside any repository yields null".

**Files under the OS temp directory.** Excluded unless inside the repository. README:46: "Files under `/tmp` or the platform temporary directory are excluded unless they lie inside the repository." Code: `isTemporaryPath` (`lib/types/paths.js:69`) against `temporaryRoots` which defaults to `['/tmp', tmpdir()]` (`lib/types/paths.js:30`), applied at `lib/index.js:889`.

**Gitignored files.** Covered through whole-file captures, not through git. README:46: the copies serve "the other paths — files matching an ignore pattern, files outside the repository, and every file-tool edit when there is no snapshot". Coverage requires the file tool to name the path (`README:94`).

**Files larger than `maxFileBytes`.** Listed without counts and without a comparison. README:41: "a larger file gets no comparison, and one captured around a file-tool edit is also listed without counts". README:46: "A copy larger than `maxFileBytes` is not stored: the file is listed with `oversized` and no counts, and a path whose both sides are that large is listed too, since unread content is never known to be unchanged." Type marker: `oversized?: true` (`types.d.ts:20`).

**Nested repositories and submodules.** Recorded as gitlinks; internals do not appear. README:44: "Nested repositories and submodules inside the working directory are recorded as gitlinks, so their internal changes do not appear." `git.d.ts:120-121`: "Work-tree directories the index records as gitlinks: nested repositories and submodules, whose contents snapshots never descend into". Code path: `gitlinkPaths` filter at `lib/index.js:884-885`.

**Shell writes with no snapshot.** Not recorded. README:44: "shell edits are absent". README:46: "Changes made only through shell commands outside the snapshot coverage are not recorded." README:94: "a file only a shell command changes there is absent, and a file both changed before its first file-tool call is compared from that call onward." Inside a git repository, shell writes **are** captured by the snapshot (the design note's stated motivation: "git sees every write regardless of the tool", note line 30).

**Additional documented limits** worth knowing (README:88-98): summaries and copies last only as long as the Session in the Host process; `core.splitIndex` writes `sharedindex.*` and git-lfs stores objects under `.git/lfs`; git 2.13+ required; the first snapshot of a session copies every untracked non-ignored file of the work tree into the Session temp directory; "Edits the user makes during a turn are attributed to that turn" (README:92); `diff()` serves complete file text to the client, while the summary route serves only paths and counts (README:96); Windows keeps native separators in `path` while `display` is always slash-separated (README:98).

## Question 4: Retention across Host restart, and session disposal

Not retained; summaries live only for the Session's lifetime in the current Host process.

README:88: "Summaries, snapshot trees, and captured copies live only as long as their Session in this Host process; earlier turns of a conversation reopened after a Host restart have no card and no comparison. This is the decided behavior: a card whose content the Host can no longer open is not shown."

README:48: "A conversation reopened after a Host restart therefore has no card, and no comparison, for its earlier turns."

Design note (archived) line 26: "Summaries, snapshot trees, and captured copies live only as long as the Session in the Host process: the summaries in the recorder, the objects and copies in a temporary directory removed on disposal. A conversation reopened after a Host restart has no card for its earlier turns. ... Content is not kept across restarts".

The design note also records that this was a deliberate choice against a prior implementation (line 42): "**A snapshot object store under the Harness home with a byte bound** was the first implementation's placement: one store per repository, shared by every Session, discarded when it outgrew the bound. It survived Host restarts that the summaries no longer do, needed two configuration fields, and made a Session's snapshot fail when another Session discarded the store; a per-Session temporary directory removes all three."

**After session disposal.** The service returns `undefined` and the temp directory is removed. `types.d.ts:89`: "the summary, or undefined once its Session was disposed or when this Host never recorded it." Code `lib/index.js:781-787`:

```js
async dispose() {
    this.lifetime.abort();
    this.records.clear();
    await this.chain;
    if (this.scratch !== void 0) await rm(await this.scratch, { recursive: true, force: true });
}
```

Trigger: `ctx.on("session/disposed", (session) => { forget(session); })` (`lib/index.js:1089-1091`). README:60: "Session disposal and plugin disposal abort queued work, forget the summaries, and remove the temporary directory."

**Critical for a completion gate:** because the summary is dropped at disposal and never persisted, a gate that wants to reason about a finished session after the fact cannot. It must read the summary while the Session is live, or accept that no proof is available. The event itself is durable in the log (`docs/persistence-changes/2026-09-14-workspace-changes-event.md`, "A new root in the same Session format version"), but it carries only the turn number, so a replayed log cannot reconstruct the file list.

## Question 5: Configuration knobs and defaults

Declared in README:36-42 and enforced in code (`lib/index.js:977-982`, matching `Config` in `lib/types/index.d.ts`):

| Field | Default | Documented meaning | Source |
|---|---|---|---|
| `timeoutMs` | `30000` | "Milliseconds one git command may run before the turn's record is abandoned" | README:38, `index.js:978` |
| `outputMaxBytes` | `8388608` | "Bytes of git output retained per command; a larger diff listing abandons the record" | README:39, `index.js:979` |
| `maxFiles` | `500` | "Maximum files carried by one summary; `total` still reports the complete count" | README:40, `index.js:980` |
| `maxFileBytes` | `2097152` | "Bytes a file may hold to be captured around a file-tool edit or read from a snapshot for its comparison" | README:41, `index.js:981` |
| `diffTimeoutMs` | `100` | "Milliseconds a line comparison may run before it degrades to whole-file replacement" | README:42, `index.js:982` |

README:28-34 documents mounting with `subprocess` and a git executable on the Host, e.g. `maxFiles: 500`. `lib/types/index.d.ts` notes: "Snapshot, capture, and comparison bounds. Invalid values fail plugin load." `maxFiles` is applied as `sorted.slice(0, this.env.maxFiles)` while `total: sorted.length` and the summed `added`/`deleted` cover the uncapped list (`lib/index.js:898, 904-908`), confirming the README's claim that `total` reports the complete count.

## Question 6: Rejected alternatives and deferred work (design note)

The note's status header is:

```
Status: implemented
Archived: 2026-09-30
```

(note lines 3-4). It was moved out of `implemented/` on 2026-09-30, which is why the installed README's `implemented/` link 404s. The note's `## Alternatives considered` section (note line 28) lists:

- **Extending the mutation-call row with hunk counts**: "kept a second, weaker implementation beside the per-call diff cards and still missed shell edits; git sees every write regardless of the tool." (line 30)
- **Diffing against `HEAD` at turn end**: "needs one command but attributes the user's uncommitted work to the turn." (line 32)
- **A git tag or `stash create` per turn**: "leaves refs in the user's repository or omits untracked files; a tree written through a private index does neither." (line 34)
- **A pure-JavaScript git or a bundled binary for hosts without git**: "adds megabytes and a platform matrix for users who mostly run without the card". (line 36)
- **Summing the hunks the file tools persist**: "it counted a repeatedly edited line more than once and could not show a whole-file comparison, so the recorder now copies the whole file at first touch instead." (line 38)
- **Recording the file list and counts in the event**: "the card would then render from the log forever, while the content it opens would not survive. It was replaced by the announcement-only event so that the card and its content share one lifetime." (line 40)
- **A snapshot object store under the Harness home with a byte bound**: "It survived Host restarts that the summaries no longer do, needed two configuration fields, and made a Session's snapshot fail when another Session discarded the store; a per-Session temporary directory removes all three." (line 42)
- **An environment-provider seam for locating git**: "was raised by the team but not settled; the plugin uses `PATH` and keeps its lookup in one place." (line 44)

**Deferred: the shadow repository** (note line 46):

> "**A shadow repository for working directories outside any repository** — a git directory under the Harness home with the work tree pointing at the working directory — would add shell edits to those users' card without adding a `.git`, but a shadow repository has no `.gitignore`, and a configured exclude list cannot reliably keep build outputs, caches, and dependency trees out of every project layout. It is deferred until that exclude policy is settled; the recorder already treats the repository as an input, so adding the tier changes only where the snapshot goes."

README:93 repeats the deferral: "a shadow repository under the Harness home is deferred until its exclude rules can replace a missing `.gitignore` reliably."

The note's `## Decision` (line 12) also states the attribution guarantee that matters most here: the two tree ids are diffed so "the summary contains exactly the turn's changes — the user's earlier uncommitted work, staged or not, is part of the baseline — and commits the model makes mid-turn cannot hide changes."

## Could not verify

- I could not find any documented accessor that returns the latest `workspace/changes` seq for a turn. I verified by reading the full `WorkspaceChanges` interface (`lib/types/types.d.ts:84-102`) and by grepping every `workspaceChanges.<method>` call site in the installed tree; only `summary()` and `diff()` are called, and both take an explicit `seq`.
- The exact meaning of "replaces earlier ones" for multiple announcements in one turn is documented but the mechanism is not: the recorder never deletes an earlier record. I inferred the effective-selection rule from the consumer code (`client.js:1187-1190`) and the absence of a delete in `lib/index.js`.
- I did not verify runtime behavior against a live Host (no test run, no live mount exercise); all claims are from source, types, and the fetched documents.
- The upstream default-branch README and the installed README differ in the design-note link only, as described in "Sources read"; I verified this with a `diff` of the two files.
