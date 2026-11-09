## Parent

personal#yhxg (Spec: dsh-completion-gate as an advisory multi-repository completion tracker)

## What to build

The finished change is verified and published. Run the plugin's canonical checks, run the static quality scan over every changed source and test file, and run a stub-host probe under `~/Trash/pocock-gate/` that feeds a change record with two repositories and prints the advisory message and the per-repository status. Record the commands and their output. Stage only the files this run changed, confirm the staged list is exactly those files, commit with a message that names the redesign, and push to the owner's origin remote. Confirm the pushed commit is the local HEAD and the worktree is clean.

Live activation is deliberately not part of this ticket: the new code loads only when the DSH host restarts, and a restart ends the session that performs it. Report that the host must be restarted once, and that a new session after the restart is where the loaded behavior can be checked.

## Acceptance criteria

- [ ] `npm run check && npm test` passes and the output is recorded.
- [ ] The static scan script has run over the uncommitted worktree, before the commit, and each crossing is dismissed with a reason or fixed.
- [ ] The stub-host probe prints one message covering both repositories and the per-repository status.
- [ ] `git diff --cached --name-only` was captured before the commit and lists exactly the files this run changed.
- [ ] The commit is pushed to the owner's remote.
- [ ] After the push, `git status --short` is empty.
- [ ] After the push, `git rev-parse HEAD` equals `git ls-remote origin refs/heads/<current branch>`.
- [ ] The close message states that a host restart is still required for activation.

## Verify

Precommit, from `/home/wilder/dsh-test/dsh-completion-gate`, while the change is still uncommitted:

```
npm run check && npm test
/home/wilder/.agents/skills/code-review/scripts/static-scan.sh worktree
node ~/Trash/pocock-gate/probe-two-repos.mjs
git diff --cached --name-only
```

Post-push, after the commit is on the remote:

```
git status --short
git rev-parse HEAD
git ls-remote origin refs/heads/$(git rev-parse --abbrev-ref HEAD)
```

## Blocked by

- personal#1tty
- personal#tz9r

## Deliverables

The verification transcript, the probe output, the commit, and the pushed branch in the plugin repository `/home/wilder/dsh-test/dsh-completion-gate`.
