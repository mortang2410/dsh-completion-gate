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
  return svc
}

function emit(svc, a, type, data) {
  svc.__listeners.get('session/event')({ id: a.id }, { type, seq: ++published, time: Date.now(), data })
}

// One turn as the host publishes it: the turn starts, then its change record is announced under a sequence number. The
// root session wrote every listed path with its own `write` tool, so each path is its obligation.
function announceTurn(svc, a, summaries, turn, cwd, paths) {
  emit(svc, a, 'turn/start', { turn })
  for (const file of paths) emit(svc, a, 'tool/call', { turn, name: 'write', arguments: JSON.stringify({ file_path: file, content: 'x\n' }) })
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

test('a folder with an empty .git entry inside another repository registers there, and the outer repository ignores the catalog', async t => {
  const outer = gitRepo('outer-')
  const nested = path.join(outer, 'nested')
  fs.mkdirSync(path.join(nested, '.git'), { recursive: true })
  fs.writeFileSync(path.join(nested, 'app.js'), 'const value = 1\n')
  const summaries = new Map()
  const svc = gateFor(t, summaries)
  const a = agentIn(outer)
  announceTurn(svc, a, summaries, 1, outer, ['nested/app.js'])
  const result = await register(svc, a, nested, [{ name: 'Nested smoke', proves: 'The nested app starts.' }])
  assert.equal(readCatalog(nested).items[0].id, 'nested-smoke')
  assert.equal(result.registered.exclusion.applied, true, 'the exclusion is applied through the repository git resolves')
  assert.equal(result.registered.exclusion.added, true)
  assert.equal(fs.realpathSync(result.registered.exclusion.file), fs.realpathSync(path.join(outer, '.git', 'info', 'exclude')), 'the line goes into the outer repository exclude file')
  assert.equal(excludeLines(outer).includes('.dsh/'), true, 'the outer repository excludes the catalog')
  const ignored = spawnSync('git', ['check-ignore', '-q', 'nested/.dsh/verification.json'], { cwd: outer })
  assert.equal(ignored.status, 0, 'git ignores the nested catalog through the outer repository local exclude')
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

test('register writes into a symlinked sibling repository, never into the workspace that links to it', async t => {
  const session = gitRepo('session-')
  const sibling = gitRepo('sibling-')
  fs.writeFileSync(path.join(sibling, 'app.js'), 'const value = 1\n')
  fs.symlinkSync(sibling, path.join(session, 'vendor'))
  const summaries = new Map()
  const svc = gateFor(t, summaries)
  const a = agentIn(session)
  // The host reports a file outside the working directory by its canonical absolute path, which is the sibling's path.
  announceTurn(svc, a, summaries, 1, session, [path.join(sibling, 'app.js')])
  await register(svc, a, 'vendor', [{ name: 'Sibling smoke', proves: 'The sibling starts.' }])
  assert.equal(fs.existsSync(path.join(session, '.dsh')), false, 'the workspace gets no catalog')
  assert.equal(readCatalog(sibling).items[0].id, 'sibling-smoke')
  assert.equal(excludeLines(sibling).includes('.dsh/'), true, 'the sibling excludes its own catalog')
  assert.equal(excludeLines(session).includes('.dsh/'), false, 'the workspace exclude file is unchanged')
})

test('register writes into a sibling subdirectory that a symlink points at, never into the workspace that links to it', async t => {
  const session = gitRepo('session-')
  const sibling = gitRepo('sibling-')
  fs.mkdirSync(path.join(sibling, 'sub'))
  fs.writeFileSync(path.join(sibling, 'sub', 'app.js'), 'const value = 1\n')
  fs.symlinkSync(path.join(sibling, 'sub'), path.join(session, 'vendor'))
  const summaries = new Map()
  const svc = gateFor(t, summaries)
  const a = agentIn(session)
  // The host reports a file outside the working directory by its canonical absolute path, which is the sibling's path.
  announceTurn(svc, a, summaries, 1, session, [path.join(sibling, 'sub', 'app.js')])
  await register(svc, a, 'vendor', [{ name: 'Sibling smoke', proves: 'The sibling starts.' }])
  assert.equal(fs.existsSync(path.join(session, '.dsh')), false, 'the workspace gets no catalog')
  assert.equal(readCatalog(sibling).items[0].id, 'sibling-smoke')
  assert.equal(excludeLines(sibling).includes('.dsh/'), true, 'the sibling excludes its own catalog')
  assert.equal(excludeLines(session).includes('.dsh/'), false, 'the workspace exclude file is unchanged')
})

// A session working in a subdirectory files a change outside every repository under that directory, and the status tells
// the model to register there. Register then writes the catalog inside the subdirectory, so the exclude line must go into
// the enclosing repository's exclude file, or the catalog shows up as an untracked file in the user's checkout.
test('register in a subdirectory of a repository excludes its catalog in that repository', async t => {
  const repo = gitRepo('subdir-')
  const sub = path.join(repo, 'sub')
  fs.mkdirSync(sub)
  const loose = path.join(path.dirname(repo), `loose-${path.basename(repo)}.js`)
  fs.writeFileSync(loose, 'export const loose = 1\n')
  t.after(() => fs.rmSync(loose, { force: true }))
  const summaries = new Map()
  const svc = gateFor(t, summaries)
  const a = agentIn(sub)
  announceTurn(svc, a, summaries, 1, sub, [loose])
  const out = await register(svc, a, sub, [{ name: 'Subdir smoke', proves: 'The catalog stays out of git.' }])
  assert.match(out.markdown, /Exclusion: \.dsh\/ was (added to|already listed in) .*\.git\/info\/exclude, so git ignores the catalog\./, out.markdown)
  assert.ok(fs.existsSync(path.join(sub, '.dsh', 'verification.json')), 'the catalog is written under the working directory')
  execFileSync('git', ['check-ignore', '-q', 'sub/.dsh/verification.json'], { cwd: repo })
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '', 'the enclosing repository stays clean')
})

test('register keeps the item text as entered, and the register and status reports still show each item on one line', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  const a = agentIn(repo)
  const result = await svc.__tool.execute({ action: 'register', repository_root: repo, items: [{ name: 'Lint\n## Forged name', proves: 'Line one\n### Forged heading' }] }, { agent: a, signal: signal() })
  const stored = readCatalog(repo).items[0]
  assert.equal(stored.name, 'Lint\n## Forged name', 'the catalog holds the name as entered')
  assert.equal(stored.proves, 'Line one\n### Forged heading', 'the catalog holds the proves text as entered')
  assert.equal(result.markdown.split('\n').some(line => line.startsWith('## Forged')), false, 'the register report starts no heading from the name')
  const { markdown } = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: signal() })
  const lines = markdown.split('\n')
  assert.equal(lines.some(line => line.startsWith('## Forged') || line.startsWith('### Forged')), false, 'the status report starts no heading from the item text')
  assert.equal(lines.filter(line => line.startsWith('- lint-forged-name: Lint ## Forged name | Proves: Line one ### Forged heading')).length, 1, 'the status item is one line')
})

test('an unreadable catalog quotes its text on one line in the status report', async t => {
  const repo = gitRepo()
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 1\n')
  const file = path.join(repo, '.dsh', 'verification.json')
  fs.mkdirSync(path.dirname(file))
  fs.writeFileSync(file, '{\n"a":\n### Forged\n}\n')
  const summaries = new Map()
  const svc = gateFor(t, summaries)
  const a = agentIn(repo)
  announceTurn(svc, a, summaries, 1, repo, ['app.js'])
  const { markdown } = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: signal() })
  const lines = markdown.split('\n')
  assert.ok(markdown.includes('### Forged'), 'the parse problem quotes the file text, so the check below is not vacuous')
  assert.equal(lines.some(line => line.startsWith('### Forged')), false, 'the quoted file text starts no heading of its own')
  assert.equal(lines.filter(line => line.startsWith('Catalog unreadable')).length, 1, 'the problem is one line')
})

test('register refuses proves longer than the 1000 character bound and writes nothing', async t => {
  const repo = gitRepo()
  const svc = gateFor(t)
  await assert.rejects(register(svc, agentIn(repo), repo, [{ name: 'Long', proves: 'x'.repeat(1001) }]), /1000 characters/)
  assert.equal(fs.existsSync(path.join(repo, '.dsh')), false)
})
