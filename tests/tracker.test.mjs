import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { CompletionGateService } from '../lib/index.js'

// The tracker is tested through CompletionGateService and a stub host, the same seam service.test.mjs uses. The stub
// is copied here rather than imported, because importing service.test.mjs would run its tests a second time.
// Test workspaces live under the task's Trash root, never the system temporary directory (AGENTS.md). The tests never
// delete them, so each run leaves its workspaces in that Trash root for the user to clear.
const workRoot = path.join(os.homedir(), 'Trash', '3t34-tests')

function makeWorkDir(prefix) {
  fs.mkdirSync(workRoot, { recursive: true })
  return fs.realpathSync(fs.mkdtempSync(path.join(workRoot, prefix)))
}

function agent(header = { cwd: process.cwd() }) { return { id: 'a', session: { header } } }

function service(host) {
  fs.mkdirSync(workRoot, { recursive: true })
  const dir = fs.mkdtempSync(path.join(workRoot, 'cg-tracker-settings-'))
  const instance = new CompletionGateService(host, {}, { settingsPath: path.join(dir, 'settings.json') })
  instance.__testSettingsDir = dir
  return instance
}

function cleanupService(instance) {
  if (instance?.__testSettingsDir) fs.rmSync(instance.__testSettingsDir, { recursive: true, force: true })
}

// The gate started against a stub host whose reflect hook serves the changed-file summaries of each turn.
let published = 0
function statusService(summaries) {
  const listeners = new Map()
  const tools = {}
  const off = () => () => {}
  const reflect = { get: name => name === 'workspaceChanges' ? { summary: (id, seq) => summaries.get(`${id}:${seq}`) } : undefined }
  const host = {
    reflect,
    on: (name, listener) => { listeners.set(name, listener); return off() },
    provide: off,
    tools: { register: definition => { tools.completion_gate = definition; return off() } },
    commands: { register: off },
    systemPrompt: { section: off },
    webServer: { register: off },
  }
  const svc = service(host)
  svc.__listeners = listeners
  svc.start()
  svc.__tool = tools.completion_gate
  return svc
}

function emit(svc, a, type, data) {
  svc.__listeners.get('session/event')({ id: a.id }, { type, seq: ++published, time: Date.now(), data })
}

// Announces one turn that changed the given paths, through the same hook the host uses.
function announceTurn(svc, a, summaries, turn, cwd, paths) {
  emit(svc, a, 'turn/start', { turn })
  const seq = published + 1
  summaries.set(`${a.id}:${seq}`, { turn, cwd, files: paths.map(p => ({ path: p, display: p, added: 1, deleted: 0 })), total: paths.length, added: paths.length, deleted: 0 })
  emit(svc, a, 'workspace/changes', { turn })
  return seq
}

function attestRepo() {
  const dir = makeWorkDir('attest-')
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'app.js'), 'const value = 1\n')
  return dir
}
const execOf = a => ({ agent: a, signal: new AbortController().signal })
const attestArgs = (session, extra) => ({ action: 'attest', repository_root: session, ...extra })
const completeAttest = session => attestArgs(session, { claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'], items: [{ id: 'unit', state: 'passed' }] })
const linesOf = async (svc, a) => (await svc.__tool.execute({ action: 'status' }, execOf(a))).markdown.split('\n')

// The problem lines of the Problems section, without their list marker.
function problemsOf(lines) {
  assert.ok(lines.includes('Problems:'), 'the report has a Problems section')
  const out = []
  for (const line of lines.slice(lines.indexOf('Problems:') + 1)) {
    if (!line.startsWith('- ')) break
    out.push(line.slice(2))
  }
  return out
}

async function attestFixture(t, files = ['app.js']) {
  const session = attestRepo()
  for (const file of files) if (!fs.existsSync(path.join(session, file))) fs.writeFileSync(path.join(session, file), 'x\n')
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const a = agent({ cwd: session })
  announceTurn(svc, a, summaries, 1, session, files)
  await svc.__tool.execute({ action: 'register', repository_root: session, items: [{ name: 'Unit', proves: 'app.js sets value' }] }, execOf(a))
  return { session, svc, a, summaries }
}

test('an attestation holds while no changed file changes, and an edited file or a new path reopens it', async t => {
  const { session, svc, a, summaries } = await attestFixture(t)
  const attested = await svc.__tool.execute(completeAttest(session), execOf(a))
  assert.equal(attested.pass, true, attested.markdown)
  assert.ok((await linesOf(svc, a)).includes('Attestation: current'), 'a status read with no change keeps the attestation')

  fs.writeFileSync(path.join(session, 'app.js'), 'const value = 2\n')
  assert.ok((await linesOf(svc, a)).includes('Attestation: missing'), 'an edited file reopens the repository')

  const again = await svc.__tool.execute(completeAttest(session), execOf(a))
  assert.equal(again.pass, true, again.markdown)
  fs.writeFileSync(path.join(session, 'new.js'), 'const added = 1\n')
  announceTurn(svc, a, summaries, 2, session, ['new.js'])
  assert.ok((await linesOf(svc, a)).includes('Attestation: missing'), 'a new path reopens the repository')
})

test('status names each unmet obligation in the stated wording', async t => {
  const { session, svc, a } = await attestFixture(t, ['app.js', 'notes.md'])
  const app = path.join(session, 'app.js')
  const notes = path.join(session, 'notes.md')
  const lines = await linesOf(svc, a)
  assert.deepEqual(problemsOf(lines), [
    `Unclaimed changed files: ${app}, ${notes}. Claim each as yours, or reject it.`,
    `Changed documentation not checked: ${notes}. Check each for staleness, bloat, and conflicting information, then attest with docs_checked true.`,
    'Catalog item not stated: unit (Unit).',
    'No current attestation for this repository.',
  ])
  assert.ok(lines.includes('Status: unfinished'))
})

test('status names a claimed code file that is not reviewed, and an unreadable catalog', async t => {
  const { session, svc, a } = await attestFixture(t)
  const unreviewed = await svc.__tool.execute(attestArgs(session, { claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: [], items: [{ id: 'unit', state: 'passed' }] }), execOf(a))
  assert.deepEqual(unreviewed.blockers, [`Claimed code files not reviewed: ${path.join(session, 'app.js')}.`])

  fs.writeFileSync(path.join(session, '.dsh', 'verification.json'), '{ not json')
  const problems = problemsOf(await linesOf(svc, a))
  assert.equal(problems[0], `Claimed code files not reviewed: ${path.join(session, 'app.js')}.`)
  assert.match(problems[1], /^The catalog cannot be read: .+\.$/)

  await assert.rejects(svc.__tool.execute(completeAttest(session), execOf(a)), error => {
    assert.match(error.message, /^attest refused\. Nothing was changed\.\n- The catalog cannot be read: /)
    return true
  })
})

test('attest is complete only when every obligation is met, and a rejected file adds no problem', async t => {
  const { session, svc, a } = await attestFixture(t, ['app.js', 'NOTES.md'])
  const rejected = await svc.__tool.execute(attestArgs(session, {
    claims: [{ path: 'app.js', decision: 'not-mine' }, { path: 'NOTES.md', decision: 'not-mine' }],
    items: [{ id: 'unit', state: 'passed' }],
  }), execOf(a))
  assert.deepEqual(rejected.blockers, [], rejected.markdown)
  assert.equal(rejected.pass, true, rejected.markdown)

  const done = await svc.__tool.execute(attestArgs(session, {
    claims: [{ path: 'app.js', decision: 'mine' }, { path: 'NOTES.md', decision: 'mine' }],
    reviewed_code_files: ['app.js'], docs_checked: true, items: [{ id: 'unit', state: 'passed' }],
  }), execOf(a))
  assert.deepEqual(done.blockers, [], done.markdown)
  assert.equal(done.pass, true, done.markdown)
  assert.ok((await linesOf(svc, a)).includes('- unit: Unit | passed'), 'the passed item is shown')
})

test('status lists each unrelated item under the repository that silenced it', async t => {
  const session = attestRepo()
  const sibling = attestRepo()
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const a = agent({ cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['app.js', path.join(sibling, 'app.js')])
  await svc.__tool.execute({ action: 'register', repository_root: session, items: [{ name: 'Unit', proves: 'app.js sets value' }, { name: 'Audit', proves: 'the audit log is complete' }] }, execOf(a))
  await svc.__tool.execute({ action: 'register', repository_root: sibling, items: [{ name: 'Smoke', proves: 'it starts' }] }, execOf(a))
  const claims = { claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'] }
  const first = await svc.__tool.execute(attestArgs(session, { ...claims, items: [{ id: 'unit', state: 'passed' }, { id: 'audit', state: 'unrelated' }] }), execOf(a))
  assert.equal(first.pass, true, first.markdown)
  const second = await svc.__tool.execute(attestArgs(sibling, { ...claims, items: [{ id: 'smoke', state: 'passed' }] }), execOf(a))
  assert.equal(second.pass, true, second.markdown)

  const lines = await linesOf(svc, a)
  const sectionOf = root => {
    const at = lines.indexOf(`Root: ${root}`)
    assert.ok(at >= 0, `the report lists ${root}`)
    const next = lines.findIndex((line, index) => index > at && line.startsWith('Root: '))
    return lines.slice(at, next === -1 ? lines.length : next)
  }
  assert.ok(sectionOf(session).includes('- audit: Audit | unrelated to this session'), `the mark is reported under its own repository:\n${sectionOf(session).join('\n')}`)
  assert.ok(!sectionOf(sibling).some(line => line.includes('unrelated')), 'a repository the session did not silence shows no mark')
})

test('a reopen keeps the unrelated mark while the passed and assumed states are cleared', async t => {
  const session = attestRepo()
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const a = agent({ cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['app.js'])
  await svc.__tool.execute({ action: 'register', repository_root: session, items: [{ name: 'Unit', proves: 'app.js sets value' }, { name: 'Browser', proves: 'the page renders' }, { name: 'Audit', proves: 'the audit log is complete' }] }, execOf(a))
  const attested = await svc.__tool.execute(attestArgs(session, {
    claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'],
    items: [{ id: 'unit', state: 'passed' }, { id: 'browser', state: 'assumed', reason: 'no display is attached' }, { id: 'audit', state: 'unrelated' }],
  }), execOf(a))
  assert.equal(attested.pass, true, attested.markdown)
  const before = await linesOf(svc, a)
  assert.ok(before.includes('- audit: Audit | unrelated to this session'), 'precondition: the mark is reported before the change')
  assert.ok(before.includes('- browser: Browser | assumed, not run: no display is attached'), 'precondition: the assumed state is reported before the change')

  fs.writeFileSync(path.join(session, 'app.js'), 'const value = 2\n')
  const lines = await linesOf(svc, a)
  assert.ok(lines.includes(`Notice: Repository ${session} changed after its attestation, so its claims and item states were cleared except those marked unrelated, and the attestation was dropped.`), 'the reopen notice names the cleared states and the exception it kept')
  assert.ok(lines.includes('- unit: Unit | not stated'), 'the passed state is cleared by the reopen')
  assert.ok(lines.includes('- browser: Browser | not stated'), 'the assumed state is cleared by the reopen')
  assert.ok(lines.includes('- audit: Audit | unrelated to this session'), 'the unrelated mark survives the reopen')
  assert.ok(lines.includes('Attestation: missing'), 'the attestation is dropped')
})

test('a later attest replaces an unrelated mark with passed and then assumed', async t => {
  const session = attestRepo()
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const a = agent({ cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['app.js'])
  await svc.__tool.execute({ action: 'register', repository_root: session, items: [{ name: 'Unit', proves: 'app.js sets value' }, { name: 'Audit', proves: 'the audit log is complete' }] }, execOf(a))
  const claims = { claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'] }
  const marked = await svc.__tool.execute(attestArgs(session, { ...claims, items: [{ id: 'unit', state: 'passed' }, { id: 'audit', state: 'unrelated' }] }), execOf(a))
  assert.equal(marked.pass, true, marked.markdown)
  assert.ok((await linesOf(svc, a)).includes('- audit: Audit | unrelated to this session'), 'precondition: the mark is stored')

  const passed = await svc.__tool.execute(attestArgs(session, { ...claims, items: [{ id: 'audit', state: 'passed' }] }), execOf(a))
  assert.equal(passed.pass, true, passed.markdown)
  assert.ok((await linesOf(svc, a)).includes('- audit: Audit | passed'), 'a later attest replaces the mark with passed')

  const assumed = await svc.__tool.execute(attestArgs(session, { ...claims, items: [{ id: 'audit', state: 'assumed', reason: 'the audit log needs data this session does not have' }] }), execOf(a))
  assert.equal(assumed.pass, true, assumed.markdown)
  assert.ok((await linesOf(svc, a)).includes('- audit: Audit | assumed, not run: the audit log needs data this session does not have'), 'a later attest replaces the mark with assumed and keeps its reason')
})

test('attest refuses each malformed argument and each unknown path or item with its message, and changes nothing', async t => {
  const { session, svc, a } = await attestFixture(t)
  const before = JSON.stringify(await svc.repositoryReport(a))
  const refusals = [
    [attestArgs(session, { claims: [{ path: 'app.js', decision: 'maybe' }] }), /claims\[0\]\.decision must be mine or not-mine\./],
    [attestArgs(session, { claims: [{ path: 'app.js', decision: 'mine' }, { path: 'app.js', decision: 'mine' }] }), /claims\[1\]\.path repeats app\.js\./],
    [attestArgs(session, { claims: [{ path: 'app.js', decision: 'mine', name: 'x' }] }), /claims\[0\] has an unknown key: name\./],
    [attestArgs(session, { claims: [{ path: 'missing.js', decision: 'mine' }] }), /missing\.js is not a changed file of this repository\./],
    [attestArgs(session, { items: [{ id: 'unit', state: 'assumed', reason: 5 }] }), /items\[0\]\.reason must be a string\./],
    [attestArgs(session, { items: [{ id: 'unit', state: 'passed', reason: 'ran it' }] }), /items\[0\] is passed, so it takes no reason\./],
    [attestArgs(session, { items: [{ id: 'unit', state: 'irrelevant' }] }), /items\[0\]\.state must be passed, assumed, or unrelated\./],
    [attestArgs(session, { items: [{ id: 'unit', state: 'unrelated', reason: 'not my work' }] }), /items\[0\] is unrelated, so it takes no reason\./],
    [attestArgs(session, { items: [{ id: 'unit', state: 'passed', name: 'Unit' }] }), /items\[0\] has an unknown key: name\./],
    [attestArgs(session, { items: [{ id: 'nope', state: 'passed' }] }), /nope is not an item in this repository's catalog\./],
    [attestArgs(session, { docs_checked: 'yes' }), /docs_checked must be true or false\./],
    [attestArgs(session, { summary: 3 }), /summary must be a string\./],
    [{ action: 'attest' }, /repository_root is required/],
  ]
  for (const [args, expected] of refusals) {
    await assert.rejects(svc.__tool.execute(args, execOf(a)), error => {
      assert.match(error.message, expected)
      assert.match(error.message, /Nothing was changed\./)
      return true
    })
  }
  assert.equal(JSON.stringify(await svc.repositoryReport(a)), before, 'a refused attest changes no claim, item state, or attestation')
})

test('attest refuses an explicit null for claims, reviewed_code_files, docs_checked, items, or summary, and changes nothing', async t => {
  const { session, svc, a } = await attestFixture(t)
  const before = JSON.stringify(await svc.repositoryReport(a))
  const nulls = [
    ['claims', /claims must be an array/],
    ['reviewed_code_files', /reviewed_code_files must be an array/],
    ['docs_checked', /docs_checked must be true or false/],
    ['items', /items must be an array/],
    ['summary', /summary must be a string/],
  ]
  for (const [field, expected] of nulls) {
    await assert.rejects(svc.__tool.execute(attestArgs(session, { [field]: null }), execOf(a)), error => {
      assert.match(error.message, expected)
      assert.match(error.message, /Nothing was changed\./)
      return true
    })
  }
  assert.equal(JSON.stringify(await svc.repositoryReport(a)), before, 'a refused attest changes no claim, item state, or attestation')
})

test('attest refuses a changed file that cannot be read, stores nothing, and accepts the attest once the file is readable', async t => {
  // Root reads a write-only file, so the unreadable state cannot be made under root.
  if (process.getuid?.() === 0) { t.skip('root reads a write-only file'); return }
  const { session, svc, a } = await attestFixture(t)
  const app = path.join(session, 'app.js')
  fs.chmodSync(app, 0o200)
  t.after(() => fs.chmodSync(app, 0o644))
  await assert.rejects(svc.__tool.execute(completeAttest(session), execOf(a)), error => {
    assert.ok(error.message.includes(`${app} cannot be read (EACCES), so nothing is attested.`), error.message)
    assert.match(error.message, /Nothing was changed\./)
    return true
  })
  assert.ok((await linesOf(svc, a)).includes('Attestation: missing'), 'the refused attest stored nothing')

  fs.chmodSync(app, 0o644)
  const accepted = await svc.__tool.execute(completeAttest(session), execOf(a))
  assert.equal(accepted.pass, true, accepted.markdown)
})
