import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChangeTracker, changeDigest, readTurnChanges } from '../lib/changes.js'
import { projectRoot } from '../lib/runner.js'

// These tests drive the gate's own turn-scoped source through a fake recorder that mimics
// the host `workspaceChanges` service: `summary(sessionId, seq)` is synchronous and returns
// the announcement for one `workspace/changes` event sequence, or undefined for a sequence
// it never announced. The fake produces its file lists from real git snapshots, so the
// coverage claims (pre-existing dirt is excluded, a shell write is included, ignored build
// output is excluded, a temp file outside the repository is excluded) are measured against
// the same mechanism the host uses rather than asserted from a hand-written list.

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tempRepo(t, { gitignore = '' } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-changes-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  git(dir, ['init', '-q', '.'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  if (gitignore) fs.writeFileSync(path.join(dir, '.gitignore'), gitignore)
  fs.writeFileSync(path.join(dir, 'app.js'), 'const value = 1\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'init'])
  return dir
}

// The host recorder's own snapshot mechanism: a private index and an object directory that
// live OUTSIDE the work tree, so the scratch state never appears as a change itself. Two
// snapshots bracket the turn and `diff-tree` reports what moved between them.
function snapshotter(repo, t) {
  const state = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-snapstate-')))
  t.after(() => fs.rmSync(state, { recursive: true, force: true }))
  fs.mkdirSync(path.join(state, 'obj'), { recursive: true })
  const env = {
    ...process.env,
    GIT_OBJECT_DIRECTORY: path.join(state, 'obj'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(repo, '.git', 'objects'),
  }
  let counter = 0
  const tree = () => {
    counter += 1
    env.GIT_INDEX_FILE = path.join(state, `idx${counter}`)
    execFileSync('git', ['add', '--all', '--ignore-errors'], { cwd: repo, env, stdio: 'ignore' })
    return execFileSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf8' }).trim()
  }
  // The written trees live in the private object directory, so the comparison must read them
  // through the same environment that produced them.
  const between = (before, after) => execFileSync('git', ['diff-tree', '-r', '-M', '--numstat', before, after], { cwd: repo, env, encoding: 'utf8' })
    .split('\n').filter(Boolean).map(line => line.split('\t').pop().trim()).filter(Boolean)
  return { tree, between }
}

// A fake `workspaceChanges` service plus the tracker the gate feeds from `session/event`.
function fakeRecorder({ sessionId, summaries = new Map(), announce } = {}) {
  const calls = []
  const service = {
    summary(id, seq) {
      calls.push({ id, seq })
      return summaries.get(`${id}:${seq}`)
    },
    async diff() { return undefined },
  }
  const tracker = new ChangeTracker()
  const announceAt = (turn, seq) => {
    const id = announce ?? sessionId
    tracker.observe({ id }, { type: 'turn/start', data: { turn } })
    tracker.observe({ id }, { type: 'workspace/changes', seq, data: { turn } })
  }
  return { service, tracker, calls, announceAt, summaries }
}

const file = (p) => ({ path: p, display: p, added: 1, deleted: 0 })
const summary = (turn, files) => ({ turn, cwd: '/repo', files, total: files.length, added: files.length, deleted: 0 })

test('a file already dirty before the turn is not attributed to it', async t => {
  const repo = tempRepo(t)
  const snap = snapshotter(repo, t)

  // The user's own uncommitted work exists before the turn starts and is never touched.
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\n')
  const before = snap.tree()
  const after = snap.tree()

  assert.deepEqual(snap.between(before, after), [], 'a pre-existing dirty file must not appear as a turn change')

  // The same repository with the old git-status source would have reported app.js.
  assert.equal(git(repo, ['status', '--porcelain=v1', '--untracked-files=all']).trim(), 'M app.js')
})

test('a file written during the turn is attributed, including by a shell command', async t => {
  const repo = tempRepo(t)
  const snap = snapshotter(repo, t)

  // Pre-existing dirt that the turn never touches.
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\n')
  const before = snap.tree()

  // A shell write, not a file-tool write: `git add --all` stages from the filesystem, so it
  // sees every write regardless of which tool made it.
  execFileSync('/bin/sh', ['-c', 'printf "const extra = 3\\n" > src.js'], { cwd: repo })
  fs.writeFileSync(path.join(repo, 'noted.md'), 'note\n')

  const changed = snap.between(before, snap.tree())
  assert.deepEqual(changed, ['noted.md', 'src.js'], `unexpected record: ${JSON.stringify(changed)}`)
})

test('a file dirty before the turn and edited again during it is attributed', async t => {
  const repo = tempRepo(t)
  const snap = snapshotter(repo, t)
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\n')
  const before = snap.tree()
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 3\n')
  assert.deepEqual(snap.between(before, snap.tree()), ['app.js'])
})

test('ignored build output is not attributed to the turn', async t => {
  const repo = tempRepo(t, { gitignore: 'dist/\nnode_modules/\n' })
  const snap = snapshotter(repo, t)
  const before = snap.tree()

  fs.mkdirSync(path.join(repo, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'dist', 'bundle.js'), 'built\n')
  fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'dep\n')
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\n')
  const after = snap.tree()

  const changed = snap.between(before, after)
  assert.deepEqual(changed, ['app.js'], `ignored output leaked into the record: ${JSON.stringify(changed)}`)
})

test('a file under the system temporary directory is not attributed when it lies outside the repository', async t => {
  const repo = tempRepo(t)
  const snap = snapshotter(repo, t)
  const before = snap.tree()

  const outside = path.join(os.tmpdir(), `cg-probe-outside-${process.pid}-${Date.now()}.txt`)
  fs.writeFileSync(outside, 'probe\n')
  t.after(() => fs.rmSync(outside, { force: true }))
  const after = snap.tree()

  const changed = snap.between(before, after)
  assert.deepEqual(changed, [], `a temp file outside the repository leaked in: ${JSON.stringify(changed)}`)
})

test('the event sequence comes from the envelope, not from the turn number', () => {
  const { service, tracker, calls, summaries, announceAt } = fakeRecorder({ sessionId: 's1' })
  summaries.set('s1:305', summary(3, [file('a.js')]))
  // Sequence 305 announces turn 3, exactly as the live host does.
  announceAt(3, 305)

  const record = readTurnChanges({ service, tracker, sessionId: 's1', turn: 3 })
  assert.equal(record.seq, 305)
  assert.deepEqual(record.files, ['a.js'])
  assert.deepEqual(calls, [{ id: 's1', seq: 305 }], 'the summary must be read by the event sequence')
})

test('the highest sequence wins when one turn announces more than once', () => {
  const { service, tracker, summaries, announceAt } = fakeRecorder({ sessionId: 's1' })
  summaries.set('s1:10', summary(4, [file('early.js')]))
  summaries.set('s1:20', summary(4, [file('late.js')]))
  announceAt(4, 20)
  announceAt(4, 10)
  assert.equal(readTurnChanges({ service, tracker, sessionId: 's1', turn: 4 }).files[0], 'late.js')
})

test('an absent recorder reports that changes cannot be determined rather than unchanged', () => {
  const tracker = new ChangeTracker()
  const record = readTurnChanges({ service: null, tracker, sessionId: 's1', turn: 1 })
  assert.equal(record.determined, false)
  assert.match(record.reason, /cannot be determined/)
})

test('a turn the recorder announced nothing for is unchanged, not undetermined', () => {
  const { service, tracker } = fakeRecorder({ sessionId: 's1' })
  // The recorder emits no event for a turn that changed nothing; that is its normal silence.
  const record = readTurnChanges({ service, tracker, sessionId: 's1', turn: 9 })
  assert.equal(record.determined, true)
  assert.deepEqual(record.files, [])
  assert.equal(record.seq, null)
})

test('a record that vanished after being announced is undetermined, not unchanged', () => {
  const { service, tracker, announceAt } = fakeRecorder({ sessionId: 's1' })
  announceAt(2, 40)
  const record = readTurnChanges({ service, tracker, sessionId: 's1', turn: 2 })
  assert.equal(record.determined, false)
  assert.match(record.reason, /no longer available/)
})

test('a throwing summary read is reported as undetermined', () => {
  const tracker = new ChangeTracker()
  tracker.observe({ id: 's1' }, { type: 'workspace/changes', seq: 7, data: { turn: 1 } })
  const service = { summary() { throw new Error('host exploded') } }
  const record = readTurnChanges({ service, tracker, sessionId: 's1', turn: 1 })
  assert.equal(record.determined, false)
  assert.match(record.reason, /host exploded/)
})

test('attestation identity changes when the turn change record changes', () => {
  const a = changeDigest('s1', 3, 305, ['a.js', 'b.js'])
  assert.equal(a, changeDigest('s1', 3, 305, ['b.js', 'a.js']), 'file order must not matter')
  assert.notEqual(a, changeDigest('s1', 3, 305, ['a.js']))
  assert.notEqual(a, changeDigest('s1', 4, 305, ['a.js', 'b.js']), 'a later turn is a different record')
  assert.notEqual(a, changeDigest('s1', 3, 306, ['a.js', 'b.js']), 'a later record sequence is different')
})

test('a record that carries fewer files than the turn changed is undetermined', () => {
  const { service, tracker, announceAt } = fakeRecorder({ sessionId: 's1' })
  // The recorder caps the list it carries but reports the complete count in `total`.
  service.entries = new Map()
  const key = 's1:305'
  announceAt(3, 305)
  service.summary = () => ({ turn: 3, cwd: '/repo', files: [file('a.js')], total: 4, added: 1, deleted: 0 })
  const record = readTurnChanges({ service, tracker, sessionId: 's1', turn: 3 })
  assert.equal(record.determined, false, 'a truncated inventory must not be treated as complete')
  assert.equal(record.truncated, true)
  assert.match(record.reason, /changed 4 files/)
})

test('a session the recorder never covers is undetermined, not unchanged', () => {
  const { service, tracker } = fakeRecorder({ sessionId: 's1' })
  // The recorder excludes subagent sessions entirely, so its silence for one of those means the
  // source is blind rather than that the turn changed nothing.
  const record = readTurnChanges({ service, tracker, sessionId: 's1', turn: 1, recorded: false })
  assert.equal(record.determined, false)
  assert.match(record.reason, /does not record this session/)
})

test('a covered session that changed nothing stays determined', () => {
  const { service, tracker } = fakeRecorder({ sessionId: 's1' })
  const record = readTurnChanges({ service, tracker, sessionId: 's1', turn: 1, recorded: true })
  assert.equal(record.determined, true)
  assert.deepEqual(record.files, [])
})

test('the project root is still located through git for running checks', async t => {
  const repo = tempRepo(t)
  const nested = path.join(repo, 'packages', 'inner')
  fs.mkdirSync(nested, { recursive: true })
  assert.equal(await projectRoot(nested), repo)
})

test('a working directory outside a repository is its own root', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-norepo-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.equal(await projectRoot(dir), dir)
})
