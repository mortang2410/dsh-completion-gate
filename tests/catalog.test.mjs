import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompletionGateService } from '../lib/index.js'

// Test workspaces live under the task's Trash root, never the system temporary directory (AGENTS.md). The tests never
// delete them, so each run leaves its workspaces in that Trash root for the user to clear.
const workRoot = path.join(os.homedir(), 'Trash', '122g-tests')

function makeWorkDir(prefix) {
  fs.mkdirSync(workRoot, { recursive: true })
  return fs.realpathSync(fs.mkdtempSync(path.join(workRoot, prefix)))
}

function gitRepo(prefix = 'repo-') {
  const dir = makeWorkDir(prefix)
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  return dir
}

function agentIn(cwd) { return { id: 'a', session: { header: { cwd } } } }

const signal = () => new AbortController().signal
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The gate runs against a stub host. The tool it registers is captured so a test can call its execute, and the change
// recorder answers the turn summaries a test announces. The run seam throws, so a register call that reached a check
// fails the test instead of running one.
let published = 0
function gateFor(t, summaries = new Map()) {
  const listeners = new Map()
  const tools = {}
  const off = () => () => {}
  const reflect = { get: name => (name === 'workspaceChanges' ? { summary: (id, seq) => summaries.get(`${id}:${seq}`) } : undefined) }
  const host = {
    reflect,
    on: (name, listener) => { listeners.set(name, listener); return off() },
    provide: off,
    tools: { register: definition => { tools.completion_gate = definition; return off() } },
    commands: { register: () => off() },
    systemPrompt: { section: off },
    webServer: { register: off },
  }
  const settingsDir = makeWorkDir('settings-')
  const svc = new CompletionGateService(host, {}, { settingsPath: path.join(settingsDir, 'settings.json') })
  svc.start()
  svc.__listeners = listeners
  svc.__tool = tools.completion_gate
  t.mock.method(svc, 'run', async () => { throw new Error('register must not start a check') })
  return svc
}

function emit(svc, a, type, data) {
  svc.__listeners.get('session/event')({ id: a.id }, { type, seq: ++published, time: Date.now(), data })
}

// One turn as the host publishes it: the turn starts, then its change record is announced under a sequence number.
function announceTurn(svc, a, summaries, turn, cwd, paths) {
  emit(svc, a, 'turn/start', { turn })
  const seq = published + 1
  summaries.set(`${a.id}:${seq}`, { turn, cwd, files: paths.map(p => ({ path: p, display: p, added: 1, deleted: 0 })), total: paths.length, added: paths.length, deleted: 0 })
  emit(svc, a, 'workspace/changes', { turn })
}

function register(svc, a, repositoryRoot, items) {
  return svc.__tool.execute({ action: 'register', repository_root: repositoryRoot, items }, { agent: a, signal: signal() })
}

function readCatalog(repo) {
  return JSON.parse(fs.readFileSync(path.join(repo, '.dsh', 'verification.json'), 'utf8'))
}

function excludeLines(repo) {
  return fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').split(/\r?\n/)
}

test('register writes a version 1 catalog whose item ids are the name slugs', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  await register(svc, agentIn(repo), repo, [{ name: 'Unit tests (npm)', proves: 'The parser handles every fixture.', command: 'npm test' }])
  const catalog = readCatalog(repo)
  assert.equal(catalog.version, 1)
  assert.equal(catalog.items.length, 1)
  const [item] = catalog.items
  assert.equal(item.id, 'unit-tests-npm')
  assert.equal(item.name, 'Unit tests (npm)')
  assert.equal(item.proves, 'The parser handles every fixture.')
  assert.equal(item.command, 'npm test')
  assert.ok(Date.parse(item.addedAt) > 0, 'addedAt is a timestamp')
  assert.equal(item.updatedAt, item.addedAt)
})

test('a missing proves is refused with an error, and no catalog or exclusion is written', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  const before = excludeLines(repo)
  await assert.rejects(register(svc, agentIn(repo), repo, [{ name: 'Lint' }]), /proves/)
  assert.equal(fs.existsSync(path.join(repo, '.dsh')), false, 'no catalog directory is created')
  assert.deepEqual(excludeLines(repo), before, 'the exclude file is unchanged')
})

test('re-registering a name updates proves and command, keeps the id and addedAt, and moves updatedAt', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  const a = agentIn(repo)
  await register(svc, a, repo, [{ name: 'Build', proves: 'It compiles.', command: 'npm run build' }])
  const first = readCatalog(repo).items[0]
  await sleep(20)
  await register(svc, a, repo, [{ name: 'Build', proves: 'It compiles on Node 22.', command: 'npm run build -- --strict' }])
  const items = readCatalog(repo).items
  assert.equal(items.length, 1, 'the name is updated in place, not added twice')
  assert.equal(items[0].id, first.id)
  assert.equal(items[0].addedAt, first.addedAt)
  assert.ok(Date.parse(items[0].updatedAt) > Date.parse(first.updatedAt), 'updatedAt moves forward')
  assert.equal(items[0].proves, 'It compiles on Node 22.')
  assert.equal(items[0].command, 'npm run build -- --strict')
})

test('two different names whose slugs collide get distinct ids', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  await register(svc, agentIn(repo), repo, [
    { name: 'Unit tests', proves: 'First.' },
    { name: 'unit-tests', proves: 'Second.' },
    { name: 'UNIT TESTS', proves: 'Third.' },
  ])
  const items = readCatalog(repo).items
  assert.deepEqual(items.map(item => item.id), ['unit-tests', 'unit-tests-2', 'unit-tests-3'])
  assert.deepEqual(items.map(item => item.name), ['Unit tests', 'unit-tests', 'UNIT TESTS'])
})

test('the .dsh/ exclude line is appended once across two registers, git ignores the catalog, and .gitignore is unchanged', async t => {
  const repo = gitRepo()
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n')
  const svc = gateFor(t)
  const a = agentIn(repo)
  await register(svc, a, repo, [{ name: 'Lint', proves: 'No lint errors.' }])
  await register(svc, a, repo, [{ name: 'Typecheck', proves: 'No type errors.' }])
  assert.equal(excludeLines(repo).filter(line => line === '.dsh/').length, 1, 'the exclude line appears exactly once')
  assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), 'node_modules/\n', 'the tracked .gitignore is not edited')
  const ignored = spawnSync('git', ['check-ignore', '-q', '.dsh/verification.json'], { cwd: repo })
  assert.equal(ignored.status, 0, 'git ignores the catalog through the local exclude')
})

test('a corrupt catalog makes register refuse, naming the path and the parse failure, and leaves its bytes unchanged', async t => {
  const repo = gitRepo()
  const file = path.join(repo, '.dsh', 'verification.json')
  fs.mkdirSync(path.dirname(file))
  const bytes = '{"version": 1, "items": [\n'
  fs.writeFileSync(file, bytes)
  const svc = gateFor(t)
  await assert.rejects(register(svc, agentIn(repo), repo, [{ name: 'Lint', proves: 'No lint errors.' }]), error => {
    assert.ok(error.message.includes(file), `the error names the catalog path: ${error.message}`)
    assert.match(error.message, /not valid JSON: \S/, 'the error names the parse failure')
    return true
  })
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'the corrupt catalog is not overwritten')
  assert.equal(excludeLines(repo).includes('.dsh/'), false, 'a refused register adds no exclude line')
})

test('a root with no git gets the catalog and reports no exclusion, without an error', async t => {
  const dir = makeWorkDir('plain-')
  const svc = gateFor(t)
  const result = await register(svc, agentIn(dir), dir, [{ name: 'Smoke', proves: 'The script starts.' }])
  assert.equal(readCatalog(dir).items[0].id, 'smoke')
  assert.equal(result.registered.exclusion.applied, false)
  assert.match(result.registered.exclusion.reason, /not a git repository/)
})

test('register refuses a repository root the session has not seen, and writes nothing there', async t => {
  const session = gitRepo('session-')
  const stranger = gitRepo('stranger-')
  const svc = gateFor(t)
  const before = excludeLines(stranger)
  await assert.rejects(register(svc, agentIn(session), stranger, [{ name: 'Lint', proves: 'No lint errors.' }]), /not a repository this session/)
  assert.equal(fs.existsSync(path.join(stranger, '.dsh')), false)
  assert.deepEqual(excludeLines(stranger), before)
})

test('register accepts a repository the session changed in an earlier turn, given as a path relative to the session', async t => {
  const session = gitRepo('session-')
  const sibling = gitRepo('sibling-')
  fs.writeFileSync(path.join(sibling, 'app.js'), 'const value = 1\n')
  const summaries = new Map()
  const svc = gateFor(t, summaries)
  const a = agentIn(session)
  announceTurn(svc, a, summaries, 1, session, [path.join(sibling, 'app.js')])
  await register(svc, a, path.relative(session, sibling), [{ name: 'Sibling smoke', proves: 'The sibling starts.' }])
  assert.equal(readCatalog(sibling).items[0].id, 'sibling-smoke')
})

test('register refuses proves longer than the 1000 character bound and writes nothing', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  await assert.rejects(register(svc, agentIn(repo), repo, [{ name: 'Long', proves: 'x'.repeat(1001) }]), /1000 characters/)
  assert.equal(fs.existsSync(path.join(repo, '.dsh')), false)
})
