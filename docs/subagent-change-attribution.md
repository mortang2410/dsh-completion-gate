# How DSH attributes file changes made by delegated (subagent) sessions

Research date: 2026-10-05. Revisions read: `deepseek-ai/deepseek-harness` `master` at
`5badb15009ae1756c3afe0ae0cef1faafc290ccc`, installed tree `@deepseek-ai/dsh-workspace-changes`
`0.2.0-rc.2` (release commit `c1b47e41fcd54d20a0f061df28683bfc29ee24e5`), and
`NousResearch/hermes-agent` `main` at `e36a818033f5246e5fcfe9a6967bb85e885ba155`.

## Summary

`@deepseek-ai/dsh-workspace-changes` refuses to record any subagent Session, but that refusal does
not hide a subagent's writes from the parent's changed-files summary. The recorder diffs whole
working-tree snapshots, and an in-process child Session inherits the parent's working directory
verbatim, so a file a child writes during the parent's turn appears in the parent turn's summary
with normal git line counts.

Three findings decide how a quality gate should consume this:

1. **The parent's summary does include delegated writes** (Question 2). This is established from
   source mechanics plus a local reproduction, not from an upstream sentence, because no upstream
   document states it explicitly.
2. **Nothing upstream attributes those writes to the child.** The summary carries no author, no
   Session id, and no delegation marker. A gate that reads the changed-files summary cannot
   distinguish a parent edit from a child edit.
3. **Upstream documents only two delegation-aware practices**: a parent must call `present` itself
   to declare a child's files, and Agent Team Leads "must coordinate ownership and review the final
   diff". There is no documented pattern for a changed-files consumer.

## Question 1: Why are subagent Sessions excluded from the recorder?

**The exclusion has no published design rationale.** I could not find any upstream text that
explains it. What exists is the rule itself, its test, and the surrounding wording "top-level turn".

The rule, in the installed tree:

```js
function eligible(session) {
	const { cwd, origin, delegationDepth } = session.header;
	return origin === "subagent" || (delegationDepth ?? 0) > 0 ? void 0 : cwd;
}
```

Source: installed `/home/wilder/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-workspace-changes/lib/index.js:984-986`.

The same function exists in the first commit that introduced the plugin. `git show` of
[`f937f4e23b1f4ee76e73e8f87f8c48a1ff8898ed`](https://github.com/deepseek-ai/deepseek-harness/commit/f937f4e23b1f4ee76e73e8f87f8c48a1ff8898ed)
(`feat(web): record turn file changes with git snapshots and render the changed-files card`) has the
condition at `packages/fs/workspace-changes/src/index.ts:57-59` unchanged, and that commit added the
README line "Every Session with a working directory and no subagent origin is recorded; subagent
Sessions are not." The behavior was therefore in the feature from its first commit. It was not added
later in response to a bug, so there is no fix commit or issue to read for a reason.

The user-facing statement (installed `README.md:44`, upstream identical):

> Every Session with a working directory and no subagent origin is recorded; subagent Sessions are
> not.

Source: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/deliverables/workspace-changes/README.md (`README.md:44`).

The archived design note for the same feature does not discuss subagents at all. It says only
"top-level turn" and never mentions delegation, `delegationDepth`, or `origin`:

> The Host [workspace-changes](...) plugin summarizes each top-level turn's changed files ...

Source: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/archived/feature/2026-09-11-turn-changed-files-card.md (`:14`).

The companion diff-preview note is likewise silent on subagents:
https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/archived/feature/2026-09-15-changed-file-diff-preview.md.

The only place the rule is exercised is a test named for the behavior, which asserts the exclusion
for both `delegationDepth: 1` and `origin: 'subagent'` and expects an empty result:

```ts
it('ignores subagent sessions and sessions without a working directory', async () => {
    const sessions = [
      ctx.sessions.create(SessionId('child'), { meta: { cwd, delegationDepth: 1 } }),
      ctx.sessions.create(SessionId('origin'), { meta: { cwd, origin: 'subagent' } }),
      ctx.sessions.create(SessionId('nowhere')),
    ]
```

Source: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/deliverables/workspace-changes/tests/plugin.spec.ts (`:460-466`).

Searches for a rationale found nothing: `api.github.com/search/issues?q=repo:deepseek-ai/deepseek-harness+subagent+changed+files`
returned `total_count: 0`, `api.github.com/search/commits?q=...workspace-changes+subagent` returned
`total_count: 0`, and no Agent Note combines subagent scope with the changed-files recorder.

**Inference (labelled as inference, not documented fact).** The most likely reason is that the
recorded summary is rendered into the Web turn tail of one Session, and a child Session's own turns
are displayed in the child's own view. Recording a child Session as well would produce a nested,
never-consulted summary, and the parent already sees the child's edits because the snapshot covers
the shared tree (Question 2). I found no upstream statement that confirms this, and the README
offers no reason. Treat it as a plausible reading of the code, not as the project's stated intent.

## Question 2: Does a parent turn's snapshot capture files a subagent wrote during that turn?

**Yes, when the write lands inside the parent turn's snapshot window.** No upstream document states
this in one sentence. It follows from four facts, each with a source, plus a local reproduction.

**Fact 1: the snapshot covers the whole working tree, not a path list.** The recorder runs
`git add --all --ignore-errors` with `cwd` set to the repository root, then `write-tree`:

```js
const added = await git.run([
	"add",
	"--all",
	"--ignore-errors",
	...pathspec
], {
	cwd: workspace.root,
	env,
	signal
});
```

Source: installed `.../dsh-workspace-changes/lib/index.js:288-298`; `snapshotTree` is declared at `:272`.
The repository root comes from `git rev-parse --show-toplevel --absolute-git-dir` (`:233-245`), so it
is the whole worktree, not the Session's immediate directory.

**Fact 2: any process that writes the tree is captured, because `add --all` stages from the
filesystem, not from tool calls.** The recorder has no knowledge of which tool or process wrote a
file. `git add --all` re-stats the worktree and `write-tree` records the result.

**Fact 3: an in-process child Session inherits the parent's working directory exactly.**
`childSessionMeta` copies the parent header's `cwd` verbatim:

```js
return {
	...parentHeader.cwd !== void 0 ? { cwd: parentHeader.cwd } : {},
	...
	origin: "subagent",
	delegationDepth: childDepth
};
```

Source: installed `.../dsh-subagent/lib/index.js:470-481`.

The ACP backend defaults its child `cwd` to the parent Session cwd as well: "`cwd` | parent session
cwd | Working-directory override for the child process and its ACP session"
(https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent-acp/README.md).
Agent Team members likewise "share cwd and observe edits immediately" and the package "provides no
worktree, remote member, merge, or filesystem lock"
(https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/agent-team/README.md:205).

**Fact 4: the turn-end snapshot is taken at the end of the parent turn, after its tool calls
settled.** The recorder "appends inside the turn on `agent/turn-stopping` and again after `turn/end`
only when tool results settled after the last record" (archived card note `:24`); the same is
described in the installed README under "Understand the implementation" (`README.md:58`) and wired at
`lib/index.js:1087` and `:1092-1095`. A foreground delegation returns before the parent's turn
stops, so the child's writes are on disk at snapshot time.

**Local reproduction.** I reproduced the exact snapshot sequence in a scratch repository: seed a
private index from the repository index, `git add --all --ignore-errors`, `git write-tree` before,
then write a file from a separate process and create a nested directory, `add --all` again,
`write-tree` after, then `git diff-tree -r -M --numstat` between the two trees. The foreign writes
appeared:

```
BEFORE=3e21a205dd9b55021aeae87965092623807e455f
AFTER=1df08f37dc91fe9c3bcb17b169ea610247392eac
--- diff-tree --numstat ---
1	0	other-agent-file.txt
1	0	sub/deep.txt
```

The second writer had no relationship to the process that took the first snapshot and made no tool
call. This is the mechanism a subagent's `write`, `edit`, shell command, or script uses.

**What this does not cover, and the boundary matters.**

- A **continuable** or **`run_in_background` one-shot** child can write *after* the parent turn has
  ended. Those writes are not in that turn's summary. Inference: because the baseline snapshot of the
  parent's *next* turn is taken with the file already changed, such a write is absorbed into that
  baseline and appears in no summary at all, matching the documented baseline rule that "the user's
  earlier uncommitted work, staged or not, is part of the baseline" (archived card note:16) and
  "a file that was already dirty before the turn is part of the baseline and is not attributed to
  the turn" (prior local research file `docs/workspace-changes-research.md`). I did not reproduce
  this timing case end to end, so treat the "appears in no summary" step as a strong inference from
  the baseline rule rather than a directly observed result.
- A remote child (ACP, Codex, Claude Code, DSH SDK) that overrides `cwd` writes outside the parent's
  snapshot and is invisible. The ACP README exposes exactly that override.
- Because the recorder refuses subagent Sessions, a child's own writes are never attributed to the
  child either. There is no summary anywhere that names the child as the author.

**Direct answer to the question as asked:** upstream documentation does not confirm or deny it in
prose. The source and a reproduction confirm it for writes that land inside the parent turn's
snapshot window.

## Question 3: What upstream documents about subagents in general

**How they are created.** Delegation is an optional capability, not part of the agent loop: "Like
bash, it is **one optional capability**, not part of the agent loop"
(https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md). A
composition mounts `@deepseek-ai/dsh-subagent`, one or more provider backends, and a model-facing
delegation tool such as `@deepseek-ai/dsh-tool-subagent`. Providers are a named registry on
`ctx.subagents`; in-process providers are `spawn` and `fork`, out-of-process ones are ACP, Codex,
Claude Code, and DSH SDK
(https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent/README.md).
An in-process child is an ordinary child Agent whose header records `origin: "subagent"` and
`parentSession` (installed `.../dsh-subagent/lib/index.js:470-481`). Depth is capped by
`subagent.maxDepth`, default `1`.

**Whether they run inside the parent's turn or across turns.** Both shapes exist and the README
separates them:

- **One-shot, foreground** (default): the call "waits in the foreground and returns the child's
  final text", so the child runs inside the parent's turn.
- **One-shot, background**: `run_in_background: true` "starts a plain parent-owned background job
  and returns `started background subagent job <id>`", collected later with `job_output`.
- **Continuable**: "starts a durable child and returns `started subagent <childId>` without waiting
  for a result; the runtime delivers one settlement notice when the child's Activation ends". A
  continuable child "may execute many FIFO turns", and settlement "happens before the ownership
  release that would let the parent be judged settled".

Source: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/tool-subagent/README.md and
https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md.

So a child does not have to run inside the parent's turn. Only the foreground one-shot case is
guaranteed to complete before the parent turn ends.

**Whether they share the parent's working directory.** Yes for in-process children: `childSessionMeta`
copies `parentHeader.cwd` verbatim and `resolveChildCwd` throws rather than inventing one when the
parent has none:

```js
function resolveChildCwd(prefix, configured, parentCwd) {
	if (configured !== void 0) return configured;
	if (parentCwd === void 0) throw new Error(`${prefix}: no working directory for the child — configure \`cwd\` or delegate from a parent session that has one`);
	return assertUsableCwd(prefix, "parent session cwd", parentCwd);
}
```

Source: installed `.../dsh-subagent/lib/index.js:2597-2601`.

**Whether their edits can be attributed to the parent.** Upstream documents author attribution for
messages, not for files, and it deliberately keeps the two apart. The subagent subsystem draws a
line between "an Agent message" the sender chose and "the runtime's own account of a continuable
child settling", with a comment explaining that merging them "would credit the child with words it
never wrote" (`docs/subsystems/subagent.md`, `SubagentSettledMessageSource`). No equivalent author
field exists on `WorkspaceChangedFile` or `WorkspaceChangesSummary`: the types carry `path`,
`display`, `added`, `deleted`, `binary`, `oversized` and, at summary level, `turn`, `cwd`, `files`,
`total`, `added`, `deleted`, `snapshot`
(https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/deliverables.md).

One upstream sentence does address attribution of a delegated *delivery*, which is the closest
analogue and is explicit:

> Delivery belongs to the calling Session; a parent must call `present` itself to declare files
> created by a subagent.

Source: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/deliverables/tool-present/README.md:42.

## Question 4: Is there a documented pattern for a quality gate that must account for delegated work?

**No documented pattern exists for a changed-files consumer.** Upstream documents three adjacent
practices, none of which is a gate over the recorded summary.

1. **The parent must re-declare a child's files.** `present` "belongs to the calling Session; a
   parent must call `present` itself to declare files created by a subagent"
   (tool-present README:42). A gate that reads only `deliverables/presented` events therefore sees
   nothing for a child's work until the parent presents it.

2. **An Agent Team Lead must review the final diff.** The experimental agent-team package states:
   "**Advisory write scopes** — Bash, formatters, code generators, and direct external writers can
   bypass filesystem version checks; Leads must coordinate ownership and review the final diff."
   Source: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/agent-team/README.md:206.
   It also warns that file hints on tasks "produce warnings when two in-progress tasks plan to touch
   overlapping paths — they never block anything" (`:79`).

3. **The changed-files card itself is a display surface, not a gate.** It "renders the summary the
   Host serves for the turn's latest `workspace/changes` announcement"; "Coding Tools must be
   enabled to show this card or request its summary", and turning that preference off "removes the
   card immediately". Source:
   https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-deliverables/README.md.
   The recorder is mounted only by the Web bundle: "The Web bundle alone mounts the recorder, so
   headless, SDK, and ACP logs are unchanged" (archived card note:52).

Also relevant to a gate: the summary is not durable and not model-visible. "Summaries, snapshot
trees, and captured copies live only as long as their Session in this Host process; earlier turns of
a conversation reopened after a Host restart have no card and no comparison"
(installed workspace-changes README:88, upstream `:86`), and the event "is log-only and never
model-visible" (archived card note:14). `ctx.workspaceChanges.summary()` returns `undefined` once
the Session is disposed.

**Inference (labelled).** Combining facts 1 and 2 from Question 2 with the absence of an author
field, a gate that needs to know whether delegated work happened has no upstream signal to read. The
available evidence for delegated edits is indirect: a delta between the parent's own tool-call log
and the recorded summary, or a direct `git status`/`git diff` inspection. I found no upstream
recommendation to do either, so neither is a documented pattern.

## Question 5: Does the DSH documentation site cover this?

**Partially. The changed-files vocabulary is published; the subagent exclusion is not.**

- The site is `https://deepseek-harness.github.io/deepseek-harness/...`. The host
  `https://deepseek-harness.dev` returns HTTP 200 but redirects to `https://www.dsh.so/`, which is a
  third-party plugin registry ("DSH Plugin Registry — Verified AI Agent Plugins"), not the project's
  documentation. I confirmed this by fetching the redirect target and reading its page text.
- The Subagents page is published and is where the site describes delegation:
  https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/subagent. It contains
  zero occurrences of "changed file" or "workspace/changes" (checked by counting matches on the raw
  site markdown: 0).
- The Deliverables page is **not** published on the site. `.../en/reference/subsystems/deliverables`
  and `.../en/reference/subsystems/deliverables.md` both return HTTP 404, while `subagent.md` returns
  200. The Subsystems index links `subagent.md` relatively but links `deliverables.md` to
  `github.com/.../docs/subsystems/deliverables.md`, which is consistent with the page being excluded
  from the site build. Source: https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/index.md.
- The Deliverables subsystem page does exist in the repository, and it is the strongest doc-level
  statement that the recorder is scoped to top-level turns: "Files changed during one top-level
  turn, kept on the Host until its Session is disposed" (`docs/subsystems/deliverables.md:48`) and
  "`workspace-changes` merges `workspace/changes: { turn }`, appended when a top-level turn stops"
  (`docs/subsystems/deliverables.md:138`).
- The site is generated from `docs/` by `website/build.ts` with the collection list in
  `website/docs.ts`; `docs/subsystems/deliverables.md` is present in the repository tree but has no
  live site route.
- The repository has no `docs/subagents` guide, no delegation how-to in `docs/user/guide/`, and no
  page about the changed-files card other than the package READMEs and the two archived notes. I
  listed the full `docs/**.md` tree and read the guide index; the guides are config, providers, MCP
  memory, network proxy, public deployments, Python SDK, schedule, and GitHub review.

## Question 6 (bonus): How does Hermes (NousResearch/hermes-agent) handle verification for delegated work?

Hermes verifies per agent and per turn, keyed by Session. Child edits are recorded against the
child's own Session, so they do not enter the parent's turn-end verification set.

**The per-turn set.** `_turn_file_mutation_paths` is reset at every turn start and is populated only
from the agent's own successful `write_file` and `patch` results:

```python
agent._turn_file_mutation_paths = set()
```

Source: https://github.com/NousResearch/hermes-agent/blob/main/agent/turn_context.py:618, inside `_reset_per_turn_agent_state`.

Population happens in `TurnExplainersMixin._record_file_mutation_result`, which returns immediately
unless the tool is one of `FILE_MUTATING_TOOL_NAMES = frozenset({"write_file", "patch"})`:

```python
if tool_name not in _FILE_MUTATING_TOOLS:
    return
...
landed = file_mutation_result_landed(tool_name, result)
if landed:
    landed_paths = _extract_landed_file_mutation_paths(tool_name, args, result)
    changed = getattr(self, "_turn_file_mutation_paths", None)
    if changed is not None:
        changed.update(landed_paths)
```

Source: https://github.com/NousResearch/hermes-agent/blob/main/agent/turn_explainers.py:125-138 and
https://github.com/NousResearch/hermes-agent/blob/main/agent/tool_result_classification.py:9.
The caller is the agent's own tool dispatch:
https://github.com/NousResearch/hermes-agent/blob/main/agent/tool_executor.py:1093-1095 (the call to
`agent._record_file_mutation_result(...)`).

**The turn-end consumer.** The stop gate reads that per-agent set:

```python
return build_verify_on_stop_nudge(
    session_id=getattr(agent, "session_id", None),
    changed_paths=getattr(agent, "_turn_file_mutation_paths", set()),
    attempts=getattr(agent, "_verification_stop_nudges", 0),
)
```

Source: https://github.com/NousResearch/hermes-agent/blob/main/agent/turn_stop_gates.py:41-46.

**Does it record or skip subagent edits?** It records them, but under the child. A delegated child is
a real `AIAgent` with its own `session_id`, and the dispatch wrapper runs its conversation inside a
child Session context:

```python
with delegated_child_context(str(getattr(child, "session_id", "") or "")):
    return child.run_conversation(
```

Source: https://github.com/NousResearch/hermes-agent/blob/main/tools/delegate_tool_child_run.py:498-500
(the same wrapper appears at `:855-857`).

The tool executor injects the running agent's own id into every tool call
(`session_id=agent.session_id or ""`, https://github.com/NousResearch/hermes-agent/blob/main/agent/agent_runtime_helpers.py:2638),
and file edits feed that id into the ledger
(`mark_workspace_edited(session_id=session_id or task_id, cwd=cwd, paths=paths)`,
https://github.com/NousResearch/hermes-agent/blob/main/tools/file_tools_read_tracking.py:365).
The ledger's state row is keyed by `(session_id, root)` (schema in
https://github.com/NousResearch/hermes-agent/blob/main/agent/verification_evidence.py, `verification_state`).

**Inference (labelled, high confidence, from source).** Because the parent's
`_turn_file_mutation_paths` is an attribute of the parent agent, reset at the parent's turn start and
written only by the parent's own `write_file`/`patch` results, a child's edits do not appear in it,
and a child's edit does not mark the parent's verification state stale for the shared workspace root.
The parent's nudge can therefore fire on the parent's own edits only, and a turn whose only edits
came from a child would produce no parent nudge. I read this from source; I did not run Hermes to
observe it.

**Config gates that apply to subagents.** One knob changes what the parent can even see:

- `delegation.worktree_isolation` (bool, default `False`): "each child gets its own git worktree off
  the parent's HEAD so parallel children never contend for one working copy. Git-only and
  local-backend-only; otherwise silently ignored."
  Source: https://github.com/NousResearch/hermes-agent/blob/main/tools/delegate_tool_config.py:115-120.
  When enabled, a child works in `<repo>/.worktrees/subagent-<id>` on branch `hermes-subagent/<id>`,
  the child is told "the parent agent will review and merge your branch", and the worktree is
  pruned only on affirmative proof (zero commits AND clean, both git probes succeeding); otherwise it
  is kept with `inspection_failed` and a note saying the values are "UNKNOWN — not proven
  zero/clean". Source: https://github.com/NousResearch/hermes-agent/blob/main/tools/subagent_worktree.py.
  This is the closest thing to a documented quality gate for delegated work that I found in either
  project: the isolation makes the parent's review a real merge step.
- `agent.verify_on_stop` / `HERMES_VERIFY_ON_STOP`: "true | false | 'auto'"; default is off, and
  `"auto"` means "on for interactive coding surfaces — CLI, TUI, desktop — and off for messaging
  surfaces" (https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/configuration.md:1270-1278).
  This gates the whole verify-on-stop mechanism; it is not subagent-specific.
- `delegation.max_spawn_depth` (default `1`) and `delegation.orchestrator_enabled` gate nested
  delegation, not verification (https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/delegation-patterns.md).

Hermes's delegation guide states the review expectation in prose rather than in code: "Subagent
summaries are just that — summaries. If a subagent says 'fixed the bug and tests pass,' verify by
running the tests yourself or reading the diff" (same delegation-patterns guide). Its shipped
`subagent-driven-development` skill prescribes a two-stage review (spec compliance, then code
quality) executed by **fresh reviewer subagents**, and the orchestration gates taxonomy it references
lists a "Revision gate" whose example is "Code reviewer checks subagent-produced code against
must-haves; dispatches fixes back to the implementer if any must-have failed"
(https://github.com/NousResearch/hermes-agent/blob/main/optional-skills/software-development/subagent-driven-development/references/gates-taxonomy.md).

## Contrast between the two projects

| Aspect | DSH `workspace-changes` | Hermes `verify-on-stop` |
|---|---|---|
| What is recorded | Files changed in the working tree, by snapshot diff | Paths named by the agent's own `write_file`/`patch` results |
| Subagent Sessions | Explicitly refused (`origin === 'subagent'` or `delegationDepth > 0`) | Recorded, under the child's own Session id |
| Child edits in the parent's set | Present in the parent turn's summary, when the write lands in the snapshot window (Question 2) | Absent from the parent's `_turn_file_mutation_paths` |
| Author attribution | None; the summary has no Session or delegation field | None; the ledger keys on the child's Session id |
| Opt-in isolation | None; children share cwd | `delegation.worktree_isolation` gives each child its own git worktree and branch |

## What I could not verify

- **No upstream rationale for the subagent exclusion.** The archived card note, the diff-preview
  note, the README, and the commit that introduced the rule all state the rule without a reason. No
  issue, PR, or discussion explains it (GitHub issue and commit searches returned zero results).
- **No upstream sentence that says the parent summary includes a child's writes.** The conclusion in
  Question 2 is built from source mechanics, package documentation, and a local reproduction. The
  reproduction used a separate writer process, not a real DSH subagent turn end to end.
- **No upstream recommended pattern for a gate over the changed-files summary**, with or without
  delegation. The `present` rule and the Agent Team "review the final diff" line are the nearest
  statements.
- **The background/continuable timing case.** I did not run a background child that writes after its
  parent turn ends, so the claim that such writes are silently absorbed into the next turn's baseline
  is an inference from the baseline rule, not an observed result.
- **Hermes behavior at runtime.** The Hermes findings are read from source at the revision named at
  the top; I did not execute Hermes to observe a child edit and its parent's nudge.
- **The `deepseek-harness.dev` domain is not the documentation site.** It redirects to a
  third-party registry. I did not treat that site as an authoritative source for DSH behavior.
