import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChangeTracker, readTurnChanges } from '../lib/changes.js'
import { absoluteOf, owningRoot } from '../lib/repositories.js'
import { RepositoryTracker } from '../lib/tracker.js'

// Each test drives the scanner and the tracker through their own seams: a real repository on disk for the walk,
// and a fake host recorder for the changed-file list. The fallback argument of owningRoot is always a directory
// that is not the expected answer, so a result equal to the fallback proves the walk did not find the repository.

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// Test workspaces live under the task's Trash root, never the system temporary directory (AGENTS.md).
const workRoot = path.join(os.homedir(), 'Trash', 'kv4x-tests')

function tempDir(t) {
  fs.mkdirSync(workRoot, { recursive: true })
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'repos-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function tempRepo(t) {
  const dir = tempDir(t)
  git(dir, ['init', '-q', '.'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(dir, 'app.js'), 'const value = 1\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'init'])
  return dir
}

function nestedState() {
  return { heads: new Map(), unreadable: [], unresolved: [], unborn: [] }
}

// Every lstat of a `.git` entry fails with EIO while `state.on` is true, the way an unreadable repository does.
function failGitLookups(t) {
  const real = fs.promises.lstat
  const state = { on: true }
  t.mock.method(fs.promises, 'lstat', async (target, ...rest) => {
    if (state.on && String(target).endsWith(`${path.sep}.git`)) {
      const error = new Error(`EIO: i/o error, lstat '${target}'`)
      error.code = 'EIO'
      throw error
    }
    return real(target, ...rest)
  })
  return state
}

// The first `.git` lookup fails with EIO and every later lookup passes through. The count shows how many lookups ran.
function failFirstGitLookup(t) {
  const real = fs.promises.lstat
  const state = { count: 0 }
  t.mock.method(fs.promises, 'lstat', async (target, ...rest) => {
    if (String(target).endsWith(`${path.sep}.git`)) {
      state.count += 1
      if (state.count === 1) {
        const error = new Error(`EIO: i/o error, lstat '${target}'`)
        error.code = 'EIO'
        throw error
      }
    }
    return real(target, ...rest)
  })
  return state
}

test('a file inside the session repository resolves to that repository', async t => {
  const repo = tempRepo(t)
  const elsewhere = tempDir(t)
  fs.mkdirSync(path.join(repo, 'src'))
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'const value = 2\n')
  assert.equal(await owningRoot(path.join(repo, 'src', 'app.js'), elsewhere), repo)
})

test('an absolute path in a sibling repository resolves to the sibling, not the session', async t => {
  const session = tempRepo(t)
  const sibling = tempRepo(t)
  assert.equal(await owningRoot(path.join(sibling, 'app.js'), session), sibling)
})

test('a relative path that climbs into a sibling repository resolves to that sibling', async t => {
  const session = tempRepo(t)
  const sibling = tempRepo(t)
  const relative = path.join('..', path.basename(sibling), 'app.js')
  assert.equal(await owningRoot(absoluteOf(session, relative), session), sibling)
})

test('a directory that is its own nested repository resolves to itself', async t => {
  const repo = tempRepo(t)
  const nested = path.join(repo, 'packages', 'inner')
  fs.mkdirSync(nested, { recursive: true })
  git(nested, ['init', '-q', '.'])
  assert.equal(await owningRoot(nested, repo), nested)
})

test('a file inside a nested repository resolves to the nested root, not the outer one', async t => {
  const repo = tempRepo(t)
  const nested = path.join(repo, 'packages', 'inner')
  fs.mkdirSync(path.join(nested, 'src'), { recursive: true })
  git(nested, ['init', '-q', '.'])
  fs.writeFileSync(path.join(nested, 'src', 'index.js'), 'export {}\n')
  assert.equal(await owningRoot(path.join(nested, 'src', 'index.js'), repo), nested)
})

test('a path outside every repository falls back to the session working directory', async t => {
  const session = tempDir(t)
  const outside = tempDir(t)
  fs.writeFileSync(path.join(outside, 'notes.txt'), 'plain\n')
  assert.equal(await owningRoot(path.join(outside, 'notes.txt'), session), session)
})

test('a symlink that loops on itself is not a directory, so its walk starts at its parent', async t => {
  const repo = tempRepo(t)
  const loop = path.join(repo, 'loop')
  fs.symlinkSync(loop, loop)
  assert.equal(await owningRoot(loop, tempDir(t)), repo)
})

test('a symlink into a subdirectory of a sibling repository resolves to that sibling, not the repository holding the link', async t => {
  const session = tempRepo(t)
  const sibling = tempRepo(t)
  fs.mkdirSync(path.join(sibling, 'sub'))
  fs.writeFileSync(path.join(sibling, 'sub', 'x.js'), 'export {}\n')
  fs.symlinkSync(path.join(sibling, 'sub'), path.join(session, 'vendor'))
  assert.equal(await owningRoot(path.join(session, 'vendor', 'x.js'), session), sibling)
})

test('a symlink to a file in a sibling repository resolves to the repository that holds the file', async t => {
  const session = tempRepo(t)
  const sibling = tempRepo(t)
  fs.symlinkSync(path.join(sibling, 'app.js'), path.join(session, 'linked.js'))
  assert.equal(await owningRoot(path.join(session, 'linked.js'), session), sibling)
})

test('a path whose directory is gone still resolves to the repository that held it', async t => {
  const repo = tempRepo(t)
  const elsewhere = tempDir(t)
  assert.equal(await owningRoot(path.join(repo, 'gone', 'x.js'), elsewhere), repo)
})

test('the owning repository follows the durable path, never the display string', async t => {
  const session = tempRepo(t)
  const sibling = tempRepo(t)
  const service = {
    summary: () => ({
      turn: 1, cwd: session,
      files: [{ path: 'app.js', display: path.join(sibling, 'app.js'), added: 1, deleted: 0 }],
      total: 1, added: 1, deleted: 0,
    }),
  }
  const tracker = new ChangeTracker()
  tracker.observe({ id: 's1' }, { type: 'workspace/changes', seq: 3, data: { turn: 1 } })
  const record = readTurnChanges({ service, tracker, sessionId: 's1', turn: 1 })
  const repos = new RepositoryTracker()
  await repos.merge('s1', { turn: 1, seq: record.seq, base: record.base, files: record.files, fallback: session })
  const listed = repos.repositories('s1')
  assert.equal(listed.length, 1)
  assert.equal(listed[0].root, session)
  assert.deepEqual(listed[0].files.map(file => file.absolute), [path.join(session, 'app.js')])
})

test('merging the same turn and sequence again changes nothing', async t => {
  const repo = tempRepo(t)
  const repos = new RepositoryTracker()
  assert.equal(await repos.merge('s1', { turn: 1, seq: 10, base: repo, files: ['app.js'], fallback: repo }), true)
  assert.equal(await repos.merge('s1', { turn: 1, seq: 10, base: repo, files: ['app.js', 'other.js'], fallback: repo }), false)
  const listed = repos.repositories('s1')
  assert.equal(listed.length, 1)
  assert.equal(listed[0].files.length, 1)
})

test('two turns that touch the same file keep one entry and refresh its content key', async t => {
  const repo = tempRepo(t)
  const repos = new RepositoryTracker()
  await repos.merge('s1', { turn: 1, seq: 10, base: repo, files: ['app.js'], fallback: repo })
  await repos.refresh('s1', nestedState())
  assert.equal(repos.repositories('s1').length, 1, 'the first turn must create the repository')
  const first = repos.repositories('s1')[0].files[0].key

  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\n')
  await repos.merge('s1', { turn: 2, seq: 11, base: repo, files: ['app.js'], fallback: repo })
  await repos.refresh('s1', nestedState())

  const listed = repos.repositories('s1')
  assert.equal(listed.length, 1)
  assert.equal(listed[0].files.length, 1, 'the same path must keep one entry')
  const entry = listed[0].files[0]
  const expected = `file:${crypto.createHash('sha256').update('const value = 2\n').digest('hex')}`
  assert.equal(entry.key, expected)
  assert.notEqual(entry.key, first, 'the content key must change when the bytes change')
  assert.equal(entry.claim, 'unclaimed')
})

test('each session keeps its own repositories, and forgetting one leaves the other', async t => {
  const repo = tempRepo(t)
  const repos = new RepositoryTracker()
  await repos.merge('s1', { turn: 1, seq: 10, base: repo, files: ['app.js'], fallback: repo })
  await repos.merge('s2', { turn: 1, seq: 20, base: repo, files: ['app.js'], fallback: repo })
  assert.equal(repos.repositories('s1').length, 1, 'session s1 must keep its repository')
  assert.equal(repos.repositories('s2').length, 1, 'session s2 must keep its repository')
  assert.equal(repos.repositories('s1')[0].files.length, 1)
  assert.equal(repos.repositories('s2')[0].files.length, 1)
  repos.forget('s1')
  assert.deepEqual(repos.repositories('s1'), [])
  assert.equal(repos.repositories('s2').length, 1)
})

test('the catalog path of each repository is the .dsh/verification.json inside it', async t => {
  const repo = tempRepo(t)
  const repos = new RepositoryTracker()
  await repos.merge('s1', { turn: 1, seq: 10, base: repo, files: ['app.js'], fallback: repo })
  assert.equal(repos.repositories('s1').length, 1, 'the merged file must create its repository')
  assert.equal(repos.repositories('s1')[0].catalogPath, path.join(repo, '.dsh', 'verification.json'))
})

test('a repository whose metadata cannot be read is an error, never the session fallback', async t => {
  const repo = tempRepo(t)
  const session = tempDir(t)
  failGitLookups(t)
  await assert.rejects(owningRoot(path.join(repo, 'app.js'), session), { code: 'EIO' })
})

test('a merge that cannot read a repository files nothing, and the next evaluation reads the turn again', async t => {
  const repo = tempRepo(t)
  const repos = new RepositoryTracker()
  const failing = failGitLookups(t)
  await assert.rejects(repos.merge('s1', { turn: 1, seq: 10, base: repo, files: ['app.js'], fallback: repo }), { code: 'EIO' })
  assert.deepEqual(repos.repositories('s1'), [], 'a failed merge must file nothing')
  failing.on = false
  assert.equal(await repos.merge('s1', { turn: 1, seq: 10, base: repo, files: ['app.js'], fallback: repo }), true, 'the failed turn must merge on the retry')
  assert.equal(repos.repositories('s1')[0].files.length, 1)
})

// The second merge waits on the first merge's filing. Only the first .git lookup fails here, so a second merge that
// looked the repository up on its own would succeed, and the status and lookup-count assertions below would fail.
test('two merges of one turn that start together both reject when the filing fails, and the retry files the turn', async t => {
  const repo = tempRepo(t)
  const repos = new RepositoryTracker()
  const lookups = failFirstGitLookup(t)
  const args = { turn: 1, seq: 10, base: repo, files: ['app.js'], fallback: repo }
  const settled = await Promise.allSettled([repos.merge('s1', args), repos.merge('s1', args)])
  assert.deepEqual(settled.map(s => s.status), ['rejected', 'rejected'], 'a merge that waits on a failed filing must reject')
  assert.equal(lookups.count, 1, 'only the first filing may look the repository up')
  assert.deepEqual(repos.repositories('s1'), [], 'a failed filing must file nothing')
  assert.equal(await repos.merge('s1', args), true, 'the retry must file the turn')
  assert.equal(repos.repositories('s1')[0].files.length, 1)
})

// The first .git lookup waits on a gate that the test opens, so the first filing stays in flight until release() runs.
// The gate is released on test exit even when an assertion fails, so no merge is left pending.
function holdFirstGitLookup(t) {
  const real = fs.promises.lstat
  const state = { count: 0, release: null }
  const gate = new Promise(resolve => { state.release = resolve })
  t.after(() => state.release())
  t.mock.method(fs.promises, 'lstat', async (target, ...rest) => {
    if (String(target).endsWith(`${path.sep}.git`)) {
      state.count += 1
      if (state.count === 1) await gate
    }
    return real(target, ...rest)
  })
  return state
}

// Deterministic form of the overlap: the first filing is held in flight, so the second merge of the same pair must
// wait on it. The second result may settle only after the first filing settles, and both results then come back.
test('a second merge of one turn stays pending until the first filing settles', async t => {
  const repo = tempRepo(t)
  const repos = new RepositoryTracker()
  const gate = holdFirstGitLookup(t)
  const args = { turn: 1, seq: 10, base: repo, files: ['app.js'], fallback: repo }
  const first = repos.merge('s1', args)
  const second = repos.merge('s1', args)
  let secondSettled = false
  second.then(() => { secondSettled = true }, () => { secondSettled = true })
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(secondSettled, false, 'the second merge must wait while the first filing is in flight')
  gate.release()
  assert.deepEqual(await Promise.all([first, second]), [true, false])
  assert.equal(repos.repositories('s1')[0].files.length, 1)
})

// A copy taken while a filing is in flight must file that turn itself. The filing writes into the tracker it started in,
// so a copy that counted it as done would hold the turn with no files.
test('a copy staged while a filing is in flight files that turn itself', async t => {
  const repo = tempRepo(t)
  const repos = new RepositoryTracker()
  const gate = holdFirstGitLookup(t)
  const args = { turn: 1, seq: 10, base: repo, files: ['app.js'], fallback: repo }
  const first = repos.merge('s1', args)
  const staged = repos.stage('s1')
  gate.release()
  assert.equal(await first, true)
  assert.equal(await staged.merge('s1', args), true, 'the copy must file the turn, not count the in-flight filing as done')
  assert.equal(staged.repositories('s1')[0].files.length, 1)
})

// The nested repository already holds the file with a claim of its own. The claim the outer repository carries must not
// replace it: only an unclaimed destination takes the claim (tracker.js reroot).
test('a file the nested repository already holds keeps the claim it holds there', async t => {
  const outer = tempRepo(t)
  const nested = path.join(outer, 'pkg')
  fs.mkdirSync(nested)
  const file = path.join(nested, 'source.js')
  fs.writeFileSync(file, 'export const value = 1\n')
  const repos = new RepositoryTracker()
  await repos.merge('s1', { turn: 1, seq: 10, base: outer, files: ['pkg/source.js'], fallback: outer })
  repos.session('s1').repos.get(outer).files.get(file).claim = 'not-mine'
  git(nested, ['init', '-q', '.'])
  await repos.merge('s1', { turn: 2, seq: 11, base: outer, files: ['pkg/source.js'], fallback: outer })
  repos.session('s1').repos.get(nested).files.get(file).claim = 'mine'
  await repos.reroot('s1', outer)
  assert.deepEqual(repos.repositories('s1').flatMap(repo => repo.files.map(entry => [repo.root, entry.absolute, entry.claim])), [[nested, file, 'mine']])
})

// The source repository keeps its item state after its last file moves out, so the state is not dropped (tracker.js reroot).
test('an emptied source repository that holds an item state is kept', async t => {
  const outer = tempRepo(t)
  const nested = path.join(outer, 'pkg')
  fs.mkdirSync(nested)
  fs.writeFileSync(path.join(nested, 'source.js'), 'export const value = 1\n')
  const repos = new RepositoryTracker()
  await repos.merge('s1', { turn: 1, seq: 10, base: outer, files: ['pkg/source.js'], fallback: outer })
  repos.session('s1').repos.get(outer).items.set('unit', { state: 'passed' })
  git(nested, ['init', '-q', '.'])
  await repos.reroot('s1', outer)
  assert.deepEqual(repos.repositories('s1').map(repo => [repo.root, repo.files.length, repo.itemStates.length]), [[outer, 0, 1], [nested, 1, 0]])
})

// The source repository keeps its attestation after its last file moves out, so the attestation is not dropped (tracker.js reroot).
test('an emptied source repository that holds an attestation is kept', async t => {
  const outer = tempRepo(t)
  const nested = path.join(outer, 'pkg')
  fs.mkdirSync(nested)
  fs.writeFileSync(path.join(nested, 'source.js'), 'export const value = 1\n')
  const repos = new RepositoryTracker()
  await repos.merge('s1', { turn: 1, seq: 10, base: outer, files: ['pkg/source.js'], fallback: outer })
  repos.applyAttest('s1', outer, { claims: [], items: [], reviewed: [], docsChecked: false }, 'now')
  git(nested, ['init', '-q', '.'])
  await repos.reroot('s1', outer)
  assert.deepEqual(repos.repositories('s1').map(repo => [repo.root, repo.files.length, Boolean(repo.attestation)]), [[outer, 0, true], [nested, 1, false]])
})
