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

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-repos-')))
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
