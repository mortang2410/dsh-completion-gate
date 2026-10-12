import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompletionGateService } from '../lib/index.js'
import { reportMarkdown } from '../lib/core.js'
import { contentKey, isDocumentationOnly, isDocumentationPath } from '../lib/changes.js'

// These tests drive the real service, so they fail if the gate goes back to a source that
// cannot separate the user's pre-existing uncommitted work from a change this session made.
// That defect is the reason this work exists: the old rule was `git status --porcelain` over
// the whole repository, which reports a file dirtied before the session as a session change.

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tempRepo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-gate-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  git(dir, ['init', '-q', '.'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(dir, 'app.js'), 'const value = 1\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'init'])
  return dir
}

// A fake host recorder: synchronous `summary(sessionId, seq)` returning the announcement for
// one `workspace/changes` event sequence, exactly like the installed service.
function recorder(entries = new Map()) {
  const announced = []
  return {
    announced,
    entries,
    summary(sessionId, seq) { announced.push(seq); return entries.get(`${sessionId}:${seq}`) },
    async diff() { return undefined },
  }
}

function service({ workspaceChanges = recorder(), settings = {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-gate-settings-')))
  const ctx = { reflect: { get: name => (name === 'workspaceChanges' ? workspaceChanges : undefined) } }
  const instance = new CompletionGateService(ctx, settings, { settingsPath: path.join(dir, 'settings.json') })
  instance.__testSettingsDir = dir
  return instance
}

function agentFor(cwd, id = 'session-1') {
  const steers = [], followups = []
  return { id, session: { header: { cwd }, events: [] }, steer: m => steers.push(m), followup: m => followups.push(m), steers, followups }
}

// Announce one `workspace/changes` event the way the host recorder does, and register the
// summary the service will serve for that sequence.
function announce(svc, sessionId, turn, seq, files) {
  svc.changes.observe({ id: sessionId }, { type: 'turn/start', data: { turn } })
  svc.changes.observe({ id: sessionId }, { type: 'workspace/changes', seq, data: { turn } })
  svc.changeService().entries.set(`${sessionId}:${seq}`, {
    turn, cwd: '/repo', files, total: files.length, added: files.length, deleted: 0,
  })
}

const file = (p) => ({ path: p, display: p, added: 1, deleted: 0 })

test('a repository with pre-existing dirt does not look changed to the gate', async t => {
  const repo = tempRepo(t)
  // The user's own uncommitted work exists before the session starts and stays untouched.
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\n')
  assert.match(git(repo, ['status', '--porcelain=v1']), /app\.js/, 'precondition: the tree is dirty')

  const svc = service()
  try {
    // No `force`: this is the ordinary stop path. The old rule reported app.js as this
    // session's change, so the gate ran the machine checks and blocked on a repository that
    // carries unrelated dirt. The turn-scoped record attributes nothing, so the gate skips.
    const report = await svc.run(agentFor(repo), new AbortController().signal)
    assert.deepEqual(report.changedFiles, [], 'pre-existing dirt must not be attributed to this session')
    assert.equal(report.skipped, true, 'a session that changed nothing is skipped, not evaluated')
    assert.equal(report.pass, true, `unexpected blockers: ${JSON.stringify(report.blockers)}`)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a turn the recorder reported changes for is attributed to the session', async t => {
  const repo = tempRepo(t)
  const changes = recorder()
  const svc = service({ workspaceChanges: changes })
  try {
    announce(svc, 'session-1', 3, 305, [file('src/feature.js')])
    const report = await svc.run(agentFor(repo), new AbortController().signal, { force: true })
    assert.deepEqual(report.changedFiles, ['src/feature.js'])
    assert.deepEqual(changes.announced, [305], 'the summary must be read by the event sequence, not the turn number')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('an absent recorder blocks saying changes cannot be determined', async t => {
  const repo = tempRepo(t)
  const svc = service({ workspaceChanges: null })
  try {
    const report = await svc.run(agentFor(repo), new AbortController().signal, { force: true })
    assert.equal(report.pass, false)
    assert.equal(report.changesDetermined, false)
    assert.match(report.blockers.join(' '), /cannot be determined/)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a documentation-only turn does not demand a test command', async t => {
  const repo = tempRepo(t)
  const svc = service({ workspaceChanges: recorder(), settings: { requireTests: true } })
  try {
    announce(svc, 'session-1', 5, 500, [file('README.md'), file('docs/guide.md'), file('LICENSE')])
    const report = await svc.run(agentFor(repo), new AbortController().signal, { force: true })
    assert.equal(report.documentationOnly, true)
    assert.deepEqual(report.checks, [], 'no behavioral check may run for a documentation-only turn')
    assert.doesNotMatch(report.blockers.join(' '), /No executable test command/, 'the missing-test blocker must not fire')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('one non-documentation path makes the turn verified as before', async t => {
  const repo = tempRepo(t)
  const svc = service({ workspaceChanges: recorder(), settings: { requireTests: true } })
  try {
    announce(svc, 'session-1', 6, 600, [file('README.md'), file('src/app.js')])
    const report = await svc.run(agentFor(repo), new AbortController().signal, { force: true })
    assert.equal(report.documentationOnly, false)
    assert.match(report.blockers.join(' '), /No executable test command/, 'a mixed change must still require a test command')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a documentation-only turn still requires attestation of every changed file', async t => {
  const repo = tempRepo(t)
  const svc = service({ workspaceChanges: recorder(), settings: { requireTests: false, requireAttestation: true } })
  try {
    announce(svc, 'session-1', 7, 700, [file('README.md')])
    const report = await svc.run(agentFor(repo), new AbortController().signal, { force: true })
    assert.equal(report.attestation.pass, false)
    assert.match(report.blockers.join(' '), /No completion attestation/, 'a prose change is still reviewed')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('the added-line scans still read a documentation-only diff', () => {
  // The classifier exempts behavioral checks only; the scanners receive the turn's added lines.
  assert.equal(isDocumentationOnly(['README.md', 'notes.txt']), true)
  assert.equal(isDocumentationPath('docs/a.mdx'), true)
  assert.equal(isDocumentationPath('LICENSE'), true)
  assert.equal(isDocumentationPath('CODEOWNERS'), true)
  assert.equal(isDocumentationPath('src/app.js'), false)
  assert.equal(isDocumentationPath('LICENSE.md'), true)
  assert.equal(isDocumentationPath('licence'), true)
  assert.equal(isDocumentationOnly([]), false, 'a turn with no changes is not exempt')
})

test('an in-turn check before the turn has any change record is undetermined and writes no ledger row', async t => {
  const repo = tempRepo(t)
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }) + '\n')
  const svc = service()
  try {
    const agent = agentFor(repo)
    // The turn has started but the recorder has announced nothing for it yet.
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })

    const report = await svc.run(agent, new AbortController().signal)
    assert.equal(report.changesDetermined, false, 'an in-turn check with no record must not report the change set as determined')
    assert.equal(report.pass, false)
    assert.match(report.blockers.join(' '), /cannot be determined/)

    // The recipe must actually run, so that a ledger write would have happened if one were made.
    const outcome = await svc.recipe(agent, {})
    assert.equal(outcome.ok, true, `the recipe did not run: ${JSON.stringify(outcome.blockers ?? outcome.problems)}`)
    assert.equal(outcome.run.pass, true)
    assert.deepEqual(svc.ledger.rowsFor('session-1'), [], 'an undetermined turn wrote a verification row')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a turn keeps its attestation across repeated stops while its files and contents are unchanged', async t => {
  const repo = tempRepo(t)
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }) + '\n')
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\n')
  const svc = service()
  try {
    const agent = agentFor(repo)
    const signal = new AbortController().signal
    // Each call is one `workspace/changes` announcement, as a stop produces it, for the same file.
    const publish = seq => {
      svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 3 } })
      svc.changes.observe({ id: 'session-1' }, { type: 'workspace/changes', seq, data: { turn: 3 } })
      svc.changeService().entries.set(`session-1:${seq}`, { turn: 3, cwd: repo, files: [file('app.js')], total: 1, added: 1, deleted: 0 })
    }
    const attestation = {
      action: 'attest', reviewed_files: ['app.js'], review_summary: 'Reviewed app.js.',
      acceptance_criteria: [{ criterion: 'app.js sets value', evidence: 'app.js line 1' }], unresolved_issues: [],
    }

    publish(305)
    await svc.stopping({ agent, turn: 3, signal })
    assert.equal(agent.steers.length, 1, 'stop 1 blocks until the change set is attested')
    assert.match(agent.steers[0].content[0].text, /No completion attestation/)

    const attested = await svc.attest(agent, attestation)
    assert.equal(attested.pass, true, `attest failed: ${JSON.stringify(attested.blockers)}`)

    publish(307)
    await svc.stopping({ agent, turn: 3, signal })
    assert.equal(agent.steers.length, 1, 'a repeated stop over an unchanged change set must not block again')
    assert.equal(svc.state(agent).lastReport.pass, true)
    assert.equal(svc.state(agent).lastReport.recordSeq, 307, 'the report names the record it was computed from')

    fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 3\n')
    publish(309)
    await svc.stopping({ agent, turn: 3, signal })
    assert.equal(agent.steers.length, 2, 'an edited file must invalidate the attestation')
    assert.match(agent.steers[1].content[0].text, /No completion attestation/)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a moved nested repository pointer changes the attestation identity and an unmoved one keeps it', async t => {
  const repo = tempRepo(t)
  // A nested repository inside the workspace. The host lists it as a changed directory.
  const child = path.join(repo, 'nested')
  fs.mkdirSync(child)
  git(child, ['init', '-q', '.'])
  git(child, ['config', 'user.email', 'test@example.com'])
  git(child, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 1\n')
  git(child, ['add', '-A'])
  git(child, ['commit', '-qm', 'child A'])

  const svc = service({ settings: { requireTests: false } })
  try {
    const agent = agentFor(repo)
    const signal = new AbortController().signal
    const publish = seq => {
      svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 5 } })
      svc.changes.observe({ id: 'session-1' }, { type: 'workspace/changes', seq, data: { turn: 5 } })
      svc.changeService().entries.set(`session-1:${seq}`, { turn: 5, cwd: repo, files: [file('nested')], total: 1, added: 1, deleted: 0 })
    }

    publish(60)
    const attested = await svc.attest(agent, {
      action: 'attest', reviewed_files: ['nested'], review_summary: 'Reviewed the nested repository pointer.',
      acceptance_criteria: [{ criterion: 'nested is at its reviewed commit', evidence: 'child HEAD at attestation' }], unresolved_issues: [],
    })
    assert.equal(attested.pass, true, `attest failed: ${JSON.stringify(attested.blockers)}`)

    // No move: the same child commit keeps the attestation valid at the next stop.
    publish(61)
    await svc.stopping({ agent, turn: 5, signal })
    assert.equal(agent.steers.length, 0, 'an unmoved nested repository must keep its attestation')

    // The child's HEAD moves after attestation, in the same turn.
    fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 2\n')
    git(child, ['add', '-A'])
    git(child, ['commit', '-qm', 'child B'])
    publish(63)
    await svc.stopping({ agent, turn: 5, signal })
    assert.equal(agent.steers.length, 1, 'a moved nested repository pointer must invalidate the attestation')
    assert.match(agent.steers[0].content[0].text, /No completion attestation/)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a change record with no changed files passes with "no changed files" under the default config', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    const signal = new AbortController().signal
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
    svc.changes.observe({ id: 'session-1' }, { type: 'workspace/changes', seq: 70, data: { turn: 1 } })
    svc.changeService().entries.set('session-1:70', { turn: 1, cwd: repo, files: [], total: 0, added: 0, deleted: 0 })
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1 } })

    // The operator's /gate is a forced run. It must report the same result as the stop check.
    await svc.stopping({ agent, turn: 1, signal })
    assert.equal(agent.steers.length, 0, 'the stop check passes a turn with no changed files')

    const report = await svc.run(agent, signal, { force: true })
    assert.equal(report.changesDetermined, true)
    assert.equal(report.pass, true, `a turn with no changed files must pass: ${JSON.stringify(report.blockers)}`)
    assert.equal(report.notice, 'no changed files')
    assert.match(reportMarkdown(report), /no changed files/)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// Regression guard for the decided behavior (overseer decision (i)). The host writes no change record for
// a turn that changed nothing, so after the turn has ended an absent record means no changes. This test
// may pass before and after a change to the gate; it exists so that the stop check and /gate cannot drift
// apart and so that the "not written yet" block cannot return after the turn ends.
test('an ended turn with no change record reads as no changes: the stop check and /gate both pass, with no ledger row', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    const signal = new AbortController().signal
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1 } })
    // No workspace/changes event is observed for this turn: the recorder writes nothing for a turn that changed nothing.

    await svc.stopping({ agent, turn: 1, signal })
    assert.equal(agent.steers.length, 0, 'the stop check passes an ended turn with no change record')
    assert.equal(svc.state(agent).lastReport.pass, true, `stop check: ${JSON.stringify(svc.state(agent).lastReport.blockers)}`)

    const forced = await svc.run(agent, signal, { force: true })
    assert.equal(forced.pass, true, `/gate must report the stop check's result: ${JSON.stringify(forced.blockers)}`)
    assert.equal(forced.changesDetermined, true)
    assert.doesNotMatch(forced.blockers.join(' '), /not been written yet/, 'an ended turn must not report its record as not yet written')
    assert.deepEqual(svc.ledger.rowsFor('session-1'), [], 'a turn with no change record must not write a ledger row')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a turn that changed nothing reports its stop result once the turn has ended', async t => {
  const repo = tempRepo(t)
  const svc = service({ settings: { requireAttestation: false, requireTests: false } })
  try {
    const agent = agentFor(repo)
    const signal = new AbortController().signal
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })

    // Before the stop, the recorder has written nothing for this turn, so its change set is undetermined.
    assert.equal((await svc.run(agent, signal)).changesDetermined, false)

    // The stop passes a turn that changed nothing. The stop hook alone does not end the turn, because a
    // steered stop continues the same turn number, so a call made now is still inside the turn.
    await svc.stopping({ agent, turn: 1, signal })
    assert.equal(agent.steers.length, 0, 'a turn that changed nothing passes its stop')
    assert.equal((await svc.run(agent, signal)).changesDetermined, false)

    // The host ends the turn after its stop. From here a missing record means the turn changed nothing.
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1 } })
    const forced = await svc.run(agent, signal, { force: true })
    assert.equal(forced.changesDetermined, true, `the stop result must hold after the turn ends: ${JSON.stringify(forced.blockers)}`)
    assert.deepEqual(forced.changedFiles, [])
    assert.equal(forced.pass, true, `unexpected blockers: ${JSON.stringify(forced.blockers)}`)

    const attested = await svc.attest(agent, {
      action: 'attest', reviewed_files: [], review_summary: 'No file changed.',
      acceptance_criteria: [{ criterion: 'no change', evidence: 'no file changed' }], unresolved_issues: [],
    })
    assert.equal(attested.changesDetermined, true)
    assert.equal(attested.pass, true, `attest after the turn ended failed: ${JSON.stringify(attested.blockers)}`)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a stop after a transient diff read failure rescans the same bytes and blocks on a new TODO', async t => {
  const repo = tempRepo(t)
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\n// TODO: remove debug\n')
  const changes = recorder()
  // The diff read fails once, at stop 1 only. Every later read succeeds.
  let failures = 1
  changes.diff = async () => {
    if (failures > 0) { failures -= 1; throw new Error('transient read failure') }
    return { kind: 'text', hunks: [{ lines: ['-const value = 1', '+const value = 2', '+// TODO: remove debug'] }] }
  }
  const svc = service({ workspaceChanges: changes, settings: { requireAttestation: false, requireTests: false } })
  try {
    const agent = agentFor(repo)
    const signal = new AbortController().signal
    const publish = seq => {
      svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 4 } })
      svc.changes.observe({ id: 'session-1' }, { type: 'workspace/changes', seq, data: { turn: 4 } })
      changes.entries.set(`session-1:${seq}`, { turn: 4, cwd: repo, files: [file('app.js')], total: 1, added: 1, deleted: 0 })
    }

    publish(50)
    await svc.stopping({ agent, turn: 4, signal })
    assert.equal(svc.state(agent).lastReport.diffGaps.length, 1, 'precondition: stop 1 recorded the failed diff read')

    // Same bytes, same listed file. The diff now reads, so the new TODO must be found.
    publish(52)
    await svc.stopping({ agent, turn: 4, signal })
    assert.equal(agent.steers.length, 1, `stop 2 must rescan the same bytes and block on the TODO: ${agent.steers.at(-1)?.content[0].text}`)
    assert.match(agent.steers[0].content[0].text, /TODO\/FIXME/)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A required check whose result depends on a file outside the change set. Its outcome changes
// without any listed file changing, which is the environment-only fix this guards.
function readyCheckRepo(t) {
  const repo = tempRepo(t)
  fs.writeFileSync(path.join(repo, 'check.js'), "process.exit(require('fs').existsSync('ready') ? 0 : 1)\n")
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { test: 'node check.js' } }, null, 2) + '\n')
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\n')
  return repo
}

function publishReady(svc, seq) {
  svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 2 } })
  svc.changes.observe({ id: 'session-1' }, { type: 'workspace/changes', seq, data: { turn: 2 } })
  svc.changeService().entries.set(`session-1:${seq}`, { turn: 2, cwd: svc.__repo, files: [file('app.js')], total: 1, added: 1, deleted: 0 })
}

test('a stop does not reuse a failing machine result, so an environment-only fix passes at the next stop', async t => {
  const repo = readyCheckRepo(t)
  const svc = service({ settings: { requireAttestation: false } })
  svc.__repo = repo
  try {
    const agent = agentFor(repo)
    const signal = new AbortController().signal
    publishReady(svc, 40)
    await svc.stopping({ agent, turn: 2, signal })
    assert.equal(agent.steers.length, 1, 'stop 1 blocks on the failing required check')
    assert.match(agent.steers[0].content[0].text, /failed\./)

    // Environment only: an ignored file outside the change set. The listed bytes are unchanged.
    fs.writeFileSync(path.join(repo, 'ready'), '')
    publishReady(svc, 42)
    await svc.stopping({ agent, turn: 2, signal })
    assert.equal(agent.steers.length, 1, `stop 2 must recompute the check and pass: ${agent.steers.at(-1)?.content[0].text}`)
    const report = svc.state(agent).lastReport
    assert.equal(report.pass, true, `unexpected blockers: ${JSON.stringify(report.blockers)}`)
    assert.equal(report.checks.find(check => check.category === 'test').pass, true)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a stop does not reuse a failing result that attest cached for the same change set', async t => {
  const repo = readyCheckRepo(t)
  const svc = service({ settings: { requireAttestation: false } })
  svc.__repo = repo
  try {
    const agent = agentFor(repo)
    const signal = new AbortController().signal
    publishReady(svc, 40)
    const failed = await svc.attest(agent, { action: 'attest', reviewed_files: ['app.js'], review_summary: 'Reviewed app.js.', acceptance_criteria: [{ criterion: 'app.js sets value', evidence: 'app.js line 1' }], unresolved_issues: [] })
    assert.equal(failed.pass, false, 'precondition: the required check fails')

    fs.writeFileSync(path.join(repo, 'ready'), '')
    publishReady(svc, 42)
    await svc.stopping({ agent, turn: 2, signal })
    assert.equal(agent.steers.length, 0, `a stop must not block on a result cached by attest: ${agent.steers.at(-1)?.content[0].text}`)
    assert.equal(svc.state(agent).lastReport.pass, true)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A nested repository whose HEAD cannot be read at one stop. The pointer does not move, so the gate must
// block with the named message for that stop, and pass again once the HEAD reads. The unreadable read must
// not replace the identity the path already had.
test('an unreadable nested HEAD blocks with the named message and passes once it reads with the pointer unchanged', async t => {
  const repo = tempRepo(t)
  const child = path.join(repo, 'nested')
  fs.mkdirSync(child)
  git(child, ['init', '-q', '.'])
  git(child, ['config', 'user.email', 'test@example.com'])
  git(child, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 1\n')
  git(child, ['add', '-A'])
  git(child, ['commit', '-qm', 'child A'])

  const svc = service({ settings: { requireTests: false } })
  try {
    const agent = agentFor(repo)
    const signal = new AbortController().signal
    const publish = seq => {
      svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 5 } })
      svc.changes.observe({ id: 'session-1' }, { type: 'workspace/changes', seq, data: { turn: 5 } })
      svc.changeService().entries.set(`session-1:${seq}`, { turn: 5, cwd: repo, files: [file('nested')], total: 1, added: 1, deleted: 0 })
    }
    const headFile = path.join(child, '.git', 'HEAD')
    const savedHead = fs.readFileSync(headFile, 'utf8')
    const named = /Nested repository nested: could not read nested HEAD; re-run \/gate\./

    publish(60)
    const attested = await svc.attest(agent, {
      action: 'attest', reviewed_files: ['nested'], review_summary: 'Reviewed the nested repository pointer.',
      acceptance_criteria: [{ criterion: 'nested is at its reviewed commit', evidence: 'child HEAD at attestation' }], unresolved_issues: [],
    })
    assert.equal(attested.pass, true, `attest failed: ${JSON.stringify(attested.blockers)}`)

    // Stop 1: the child HEAD reads and the pointer is unchanged, so the stop passes.
    publish(61)
    await svc.stopping({ agent, turn: 5, signal })
    assert.equal(agent.steers.length, 0, 'stop 1 passes at the attested commit')

    // Stop 2: git cannot read the child HEAD, because HEAD names a branch that does not exist. The pointer did not move.
    fs.writeFileSync(headFile, 'ref: refs/heads/missing-for-test\n')
    publish(62)
    await svc.stopping({ agent, turn: 5, signal })
    assert.equal(agent.steers.length, 1, 'stop 2 blocks while the nested HEAD cannot be read')
    assert.match(agent.steers[0].content[0].text, named)
    assert.doesNotMatch(agent.steers[0].content[0].text, /No completion attestation/, 'an unreadable HEAD must not replace the identity of the path')

    const during = await svc.run(agent, signal, { force: true })
    assert.equal(during.pass, false, '/gate during the failure window must block')
    assert.match(during.blockers.join(' '), named, '/gate names the same block during the failure window')

    // Stop 3: the HEAD reads again at the same commit, so the stop passes.
    fs.writeFileSync(headFile, savedHead)
    publish(63)
    await svc.stopping({ agent, turn: 5, signal })
    assert.equal(agent.steers.length, 1, `stop 3 must pass once the nested HEAD reads again: ${agent.steers.at(-1)?.content[0].text}`)
    assert.equal(svc.state(agent).lastReport.pass, true, `unexpected blockers: ${JSON.stringify(svc.state(agent).lastReport.blockers)}`)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A nested repository under a directory whose name contains a newline. git prints the top-level path before
// the HEAD commit, so the path must not be split on its newline, or the moved pointer is never seen.
test('a moved nested pointer under a path containing a newline changes the attestation identity', async t => {
  const repo = tempRepo(t)
  const listed = 'odd\ndir/nested'
  const child = path.join(repo, 'odd\ndir', 'nested')
  fs.mkdirSync(child, { recursive: true })
  git(child, ['init', '-q', '.'])
  git(child, ['config', 'user.email', 'test@example.com'])
  git(child, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 1\n')
  git(child, ['add', '-A'])
  git(child, ['commit', '-qm', 'child A'])
  const headA = git(child, ['rev-parse', 'HEAD']).trim()

  // The identity of the listed directory is its child's HEAD, even under a newline path.
  assert.equal(await contentKey(repo, listed), `head:${headA}`, 'a nested pointer under a newline path is keyed by its HEAD')

  const svc = service({ settings: { requireTests: false } })
  try {
    const agent = agentFor(repo)
    const signal = new AbortController().signal
    const publish = seq => {
      svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 6 } })
      svc.changes.observe({ id: 'session-1' }, { type: 'workspace/changes', seq, data: { turn: 6 } })
      svc.changeService().entries.set(`session-1:${seq}`, { turn: 6, cwd: repo, files: [file(listed)], total: 1, added: 1, deleted: 0 })
    }

    publish(70)
    const attested = await svc.attest(agent, {
      action: 'attest', reviewed_files: [listed], review_summary: 'Reviewed the nested repository pointer.',
      acceptance_criteria: [{ criterion: 'nested is at its reviewed commit', evidence: 'child HEAD at attestation' }], unresolved_issues: [],
    })
    assert.equal(attested.pass, true, `attest failed: ${JSON.stringify(attested.blockers)}`)
    publish(71)
    await svc.stopping({ agent, turn: 6, signal })
    assert.equal(agent.steers.length, 0, 'precondition: the unmoved pointer passes')

    // The child's HEAD moves after attestation, in the same turn.
    fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 2\n')
    git(child, ['add', '-A'])
    git(child, ['commit', '-qm', 'child B'])
    assert.notEqual(await contentKey(repo, listed), `head:${headA}`, 'the moved pointer changes the key')
    publish(73)
    await svc.stopping({ agent, turn: 6, signal })
    assert.equal(agent.steers.length, 1, 'a moved pointer under a newline path must block the next stop')
    assert.match(agent.steers[0].content[0].text, /No completion attestation/)

    const forced = await svc.run(agent, signal, { force: true })
    assert.equal(forced.pass, false, '/gate must block a moved pointer under a newline path')
    assert.match(forced.blockers.join(' '), /No completion attestation/)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// Before any turn of the session has completed, nothing is known about its changes. An explicit /gate must
// fail closed, not report "no changed files" at HEAD.
test('a /gate before any turn has completed is undetermined, not a pass', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    const signal = new AbortController().signal
    const fresh = await svc.run(agent, signal, { force: true })
    assert.equal(fresh.changesDetermined, false, 'a fresh session has no completed turn to read')
    assert.equal(fresh.pass, false, `a /gate with no completed turn must not pass: ${JSON.stringify(fresh.blockers)}`)
    assert.match(reportMarkdown(fresh), /no completed turn in this session/)

    // A turn that has started but not completed is the same case for an explicit /gate.
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
    const open = await svc.run(agent, signal, { force: true })
    assert.equal(open.pass, false, `a /gate inside the first turn must not pass: ${JSON.stringify(open.blockers)}`)
    assert.match(reportMarkdown(open), /no completed turn in this session/)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// An absent record after the turn has ended passes, as the stop check does. The output must state that basis
// and must never say the turn was verified or that no change was verified.
test('a PASS from an absent record states its basis and never claims a verified no-change result', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const signal = new AbortController().signal

    // A turn that called a tool and produced no announced change.
    const toolAgent = agentFor(repo, 'session-1')
    toolAgent.session.events.push({ type: 'tool/call', data: { turn: 1 } }, { type: 'tool/result', data: { turn: 1 } })
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1 } })
    const tool = await svc.run(toolAgent, signal, { force: true })
    const toolText = reportMarkdown(tool)
    assert.equal(tool.pass, true, `a turn with no announced change passes: ${JSON.stringify(tool.blockers)}`)
    assert.equal(tool.notice, 'no host change record for this turn')
    assert.match(toolText, /no host change record for this turn/)
    assert.doesNotMatch(toolText, /verified|no changed files|text-only/)

    // A text-only turn: the host never inspects it, so the output names that.
    const textAgent = agentFor(repo, 'session-2')
    textAgent.session.events.push({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Done.' }] } } })
    svc.changes.observe({ id: 'session-2' }, { type: 'turn/start', data: { turn: 1 } })
    svc.changes.observe({ id: 'session-2' }, { type: 'turn/end', data: { turn: 1 } })
    const text = await svc.run(textAgent, signal, { force: true })
    const textText = reportMarkdown(text)
    assert.equal(text.pass, true, `a text-only turn with no record passes: ${JSON.stringify(text.blockers)}`)
    assert.match(textText, /text-only turn, not inspected/)
    assert.match(textText, /no host change record for this turn/)
    assert.doesNotMatch(textText, /verified|no changed files/)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})
