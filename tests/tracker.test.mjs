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
const completeAttest = session => attestArgs(session, { claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }], items: [{ id: 'unit', state: 'passed' }] })
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
  assert.ok((await linesOf(svc, a)).includes('Attestation: stale'), 'an edited file reopens the repository')

  const again = await svc.__tool.execute(completeAttest(session), execOf(a))
  assert.equal(again.pass, true, again.markdown)
  fs.writeFileSync(path.join(session, 'new.js'), 'const added = 1\n')
  announceTurn(svc, a, summaries, 2, session, ['new.js'])
  assert.ok((await linesOf(svc, a)).includes('Attestation: stale'), 'a new path reopens the repository')
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

// Ticket personal#tz9r: the reviewed state beside the claim. Every recorded file starts unreviewed, the attestation is the
// only thing that marks a review, the latest attestation decides, and reopening clears the state with the claims.
test('every recorded changed file starts unreviewed, and status prints its claim and reviewed state', async t => {
  const { session, svc, a } = await attestFixture(t, ['app.js', 'notes.md'])
  const lines = await linesOf(svc, a)
  assert.ok(lines.includes(`- ${path.join(session, 'app.js')} (unclaimed, unreviewed)`), `the code file starts unreviewed:\n${lines.join('\n')}`)
  assert.ok(lines.includes(`- ${path.join(session, 'notes.md')} (unclaimed, unreviewed)`), 'the documentation file starts unreviewed')
})

test('attest reviews its reviewed code files, and a true documentation check reviews the documentation files', async t => {
  const { session, svc, a } = await attestFixture(t, ['app.js', 'notes.md'])
  const app = path.join(session, 'app.js')
  const notes = path.join(session, 'notes.md')
  const unchecked = await svc.__tool.execute(attestArgs(session, {
    claims: [{ path: 'app.js', decision: 'mine' }, { path: 'notes.md', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }, { path: 'notes.md', note: 'read the rendered page' }], docs_checked: false, items: [{ id: 'unit', state: 'passed' }],
  }), execOf(a))
  assert.deepEqual(unchecked.blockers, [`Changed documentation not checked: ${notes}. Check each for staleness, bloat, and conflicting information, then attest with docs_checked true.`])
  const before = await linesOf(svc, a)
  assert.ok(before.includes(`- ${app} (mine, reviewed and demonstrated: ran the fixture)`), `the reviewed code file is reviewed:\n${before.join('\n')}`)
  assert.ok(before.includes(`- ${notes} (mine, unreviewed)`), 'a false documentation check leaves the document unreviewed')

  const checked = await svc.__tool.execute(attestArgs(session, { reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }, { path: 'notes.md', note: 'read the rendered page' }], docs_checked: true, items: [{ id: 'unit', state: 'passed' }] }), execOf(a))
  assert.deepEqual(checked.blockers, [], checked.markdown)
  const after = await linesOf(svc, a)
  assert.ok(after.includes(`- ${notes} (mine, reviewed and demonstrated: read the rendered page)`), 'a true documentation check reviews the document, and a listed run demonstrates it')
})

test('the latest attestation decides, so a file it does not cover is unreviewed again', async t => {
  const { session, svc, a } = await attestFixture(t, ['app.js', 'other.js'])
  const app = path.join(session, 'app.js')
  const other = path.join(session, 'other.js')
  const both = await svc.__tool.execute(attestArgs(session, {
    claims: [{ path: 'app.js', decision: 'mine' }, { path: 'other.js', decision: 'mine' }],
    reviewed_code_files: ['app.js', 'other.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }, { path: 'other.js', note: 'ran the fixture' }], items: [{ id: 'unit', state: 'passed' }],
  }), execOf(a))
  assert.equal(both.pass, true, both.markdown)
  assert.ok((await linesOf(svc, a)).includes(`- ${other} (mine, reviewed and demonstrated: ran the fixture)`), 'precondition: the first attestation covered other.js')

  const later = await svc.__tool.execute(attestArgs(session, { reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }], items: [{ id: 'unit', state: 'passed' }] }), execOf(a))
  assert.deepEqual(later.blockers, [`Claimed code files not reviewed: ${other}.`])
  const lines = await linesOf(svc, a)
  assert.ok(lines.includes(`- ${app} (mine, reviewed and demonstrated: ran the fixture)`), 'a file the latest attestation covers stays reviewed')
  assert.ok(lines.includes(`- ${other} (mine, unreviewed)`), `a file the latest attestation does not cover is unreviewed:\n${lines.join('\n')}`)
})

test('reopening clears every file reviewed state with the claims', async t => {
  const { session, svc, a } = await attestFixture(t, ['app.js', 'notes.md'])
  const app = path.join(session, 'app.js')
  const notes = path.join(session, 'notes.md')
  const done = await svc.__tool.execute(attestArgs(session, {
    claims: [{ path: 'app.js', decision: 'mine' }, { path: 'notes.md', decision: 'mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }, { path: 'notes.md', note: 'read the rendered page' }], docs_checked: true, items: [{ id: 'unit', state: 'passed' }],
  }), execOf(a))
  assert.equal(done.pass, true, done.markdown)
  const before = await linesOf(svc, a)
  assert.ok(before.includes(`- ${app} (mine, reviewed and demonstrated: ran the fixture)`), 'precondition: the code file is reviewed')
  assert.ok(before.includes(`- ${notes} (mine, reviewed and demonstrated: read the rendered page)`), 'precondition: the documentation file is reviewed')

  fs.writeFileSync(app, 'const value = 2\n')
  const lines = await linesOf(svc, a)
  assert.ok(lines.includes(`- ${app} (unclaimed, unreviewed)`), `the reopened code file is unclaimed and unreviewed:\n${lines.join('\n')}`)
  assert.ok(lines.includes(`- ${notes} (unclaimed, unreviewed)`), 'the reopened documentation file is unreviewed too')
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
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }, { path: 'NOTES.md', note: 'read the rendered page' }], docs_checked: true, items: [{ id: 'unit', state: 'passed' }],
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
  const claims = { claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }] }
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
    claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }],
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
  assert.ok(lines.includes('Attestation: stale'), 'the attestation is dropped, and the report says why in one word')
})

test('a later attest replaces an unrelated mark with passed and then assumed', async t => {
  const session = attestRepo()
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const a = agent({ cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['app.js'])
  await svc.__tool.execute({ action: 'register', repository_root: session, items: [{ name: 'Unit', proves: 'app.js sets value' }, { name: 'Audit', proves: 'the audit log is complete' }] }, execOf(a))
  const claims = { claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }] }
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

// The exported RepositoryTracker keeps reopenChanged's return contract: the reopened roots as sorted strings. The reopen
// notice asks hasUnrelatedMark for the fact it prints, so the shape a caller of the exported class already uses does not
// change (personal#f3za).
test('reopenChanged returns the reopened roots as sorted strings', async t => {
  const session = attestRepo()
  const sibling = attestRepo()
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const a = agent({ cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['app.js', path.join(sibling, 'app.js')])
  const claims = { claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }] }
  for (const root of [session, sibling]) {
    const result = await svc.__tool.execute(attestArgs(root, { ...claims, items: [] }), execOf(a))
    assert.equal(result.pass, true, result.markdown)
  }
  fs.writeFileSync(path.join(session, 'app.js'), 'const value = 2\n')
  fs.writeFileSync(path.join(sibling, 'app.js'), 'const value = 3\n')
  await svc.repositories.refresh(a.id)
  assert.deepEqual(svc.repositories.reopenChanged(a.id), [session, sibling].sort())
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

// The demonstrated state, above reviewed. A review is a reading, so the gate treats a claimed file the session has read
// but never run as unfinished, and it says so in the words a model can act on.
const UNDEMONSTRATED = app => `Claimed files reviewed but not demonstrated: ${app}. A review is only a reading, so run the change where it is used, then attest with demonstrated_files listing each path and what the run showed.`

test('a reviewed file with no run stays unfinished and is named as not demonstrated', async t => {
  const { session, svc, a } = await attestFixture(t)
  const app = path.join(session, 'app.js')
  const reviewed = await svc.__tool.execute(attestArgs(session, {
    claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'], items: [{ id: 'unit', state: 'passed' }],
  }), execOf(a))
  assert.deepEqual(reviewed.blockers, [UNDEMONSTRATED(app)], reviewed.markdown)
  assert.equal(reviewed.pass, false, 'a review is not a run, so the repository stays unfinished')
  const lines = await linesOf(svc, a)
  assert.ok(lines.includes(`- ${app} (mine, reviewed, not demonstrated)`), `the file prints as reviewed but not demonstrated:\n${lines.join('\n')}`)

  const demonstrated = await svc.__tool.execute(completeAttest(session), execOf(a))
  assert.deepEqual(demonstrated.blockers, [], demonstrated.markdown)
  assert.equal(demonstrated.pass, true, demonstrated.markdown)
  assert.ok((await linesOf(svc, a)).includes(`- ${app} (mine, reviewed and demonstrated: ran the fixture)`), 'the run that demonstrated the file is reported with the file')
})

test('the advisory names the reviewed but undemonstrated files and tells the model to exercise the change', async t => {
  const { session, svc, a } = await attestFixture(t)
  const app = path.join(session, 'app.js')
  await svc.__tool.execute(attestArgs(session, {
    claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'], items: [{ id: 'unit', state: 'passed' }],
  }), execOf(a))
  const lines = await linesOf(svc, a)
  assert.deepEqual(problemsOf(lines), [UNDEMONSTRATED(app)], 'the status report names the same problem')
  const section = (await svc.repositoryReport(a)).repositories[0]
  assert.deepEqual(section.undemonstrated, [app], 'the structured list the advisory renders names the file')
})

test('attest refuses a demonstration with no note, a path that is not a changed file, and repeated or unknown keys, changing nothing', async t => {
  const { session, svc, a } = await attestFixture(t)
  const app = path.join(session, 'app.js')
  const before = JSON.stringify(await svc.repositoryReport(a))
  const claim = { claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'] }
  const refusals = [
    [attestArgs(session, { ...claim, demonstrated_files: [{ path: 'app.js', note: '   ' }] }), new RegExp(`^attest refused\\. Nothing was changed\\.\\n- app\\.js is demonstrated with no note\\.`)],
    [attestArgs(session, { ...claim, demonstrated_files: [{ path: 'app.js' }] }), /app\.js is demonstrated with no note\./],
    [attestArgs(session, { ...claim, demonstrated_files: [{ path: 'missing.js', note: 'ran it' }] }), /missing\.js is not a changed file of this repository\./],
    [attestArgs(session, { ...claim, demonstrated_files: [{ path: 'app.js', note: 'a' }, { path: 'app.js', note: 'b' }] }), /demonstrated_files\[1\]\.path repeats app\.js\./],
    [attestArgs(session, { ...claim, demonstrated_files: [{ path: 'app.js', note: 'ran it', command: 'npm test' }] }), /demonstrated_files\[0\] has an unknown key: command\./],
    [attestArgs(session, { ...claim, demonstrated_files: [{ path: 'app.js', note: 5 }] }), /demonstrated_files\[0\]\.note must be a string\./],
  ]
  for (const [args, expected] of refusals) {
    await assert.rejects(svc.__tool.execute(args, execOf(a)), error => {
      assert.match(error.message, expected)
      assert.match(error.message, /Nothing was changed\./)
      return true
    })
  }
  assert.equal(JSON.stringify(await svc.repositoryReport(a)), before, 'a refused attest changes no claim, review, demonstration, item state, or attestation')
  assert.ok(!(await linesOf(svc, a)).some(line => line.startsWith(`- ${app} (mine, reviewed and demonstrated`)), 'no demonstration was stored')
})

test('a later attest clears an earlier demonstration it does not repeat, and a reopen clears it with the review', async t => {
  const { session, svc, a } = await attestFixture(t)
  const app = path.join(session, 'app.js')
  const first = await svc.__tool.execute(completeAttest(session), execOf(a))
  assert.equal(first.pass, true, first.markdown)
  assert.ok((await linesOf(svc, a)).includes(`- ${app} (mine, reviewed and demonstrated: ran the fixture)`), 'precondition: the file is demonstrated')

  const reviewedOnly = await svc.__tool.execute(attestArgs(session, {
    claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'], items: [{ id: 'unit', state: 'passed' }],
  }), execOf(a))
  assert.deepEqual(reviewedOnly.blockers, [UNDEMONSTRATED(app)], 'the latest attestation decides, so a run it does not repeat is gone')
  assert.ok((await linesOf(svc, a)).includes(`- ${app} (mine, reviewed, not demonstrated)`), 'the file prints as reviewed but not demonstrated after the second attest')

  const again = await svc.__tool.execute(completeAttest(session), execOf(a))
  assert.equal(again.pass, true, again.markdown)
  fs.writeFileSync(app, 'const value = 2\n')
  assert.ok((await linesOf(svc, a)).includes(`- ${app} (unclaimed, unreviewed)`), 'a changed file reopens the repository, so its review and its run are both cleared')
})

test('a rejected file needs no demonstration, and its run is not reported', async t => {
  const { session, svc, a } = await attestFixture(t, ['app.js', 'other.js'])
  const other = path.join(session, 'other.js')
  const result = await svc.__tool.execute(attestArgs(session, {
    claims: [{ path: 'app.js', decision: 'mine' }, { path: 'other.js', decision: 'not-mine' }],
    reviewed_code_files: ['app.js'], demonstrated_files: [{ path: 'app.js', note: 'ran the fixture' }], items: [{ id: 'unit', state: 'passed' }],
  }), execOf(a))
  assert.deepEqual(result.blockers, [], result.markdown)
  assert.ok((await linesOf(svc, a)).includes(`- ${other} (not-mine, rejected, so no review or demonstration is owed)`), 'a rejected file keeps no evidence state')
})
