import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompletionGateService } from '../lib/index.js'
import { isDocumentationOnly, isDocumentationPath } from '../lib/changes.js'

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
