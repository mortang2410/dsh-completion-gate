import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompletionGateService } from '../lib/index.js'
import { contentKey, isDocumentationPath } from '../lib/changes.js'

// These tests drive the real service, so they fail if the gate goes back to a source that
// cannot separate the user's pre-existing uncommitted work from a change this session made.
// That defect is the reason this work exists: the old rule was `git status --porcelain` over
// the whole repository, which reports a file dirtied before the session as a session change.

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// Test workspaces live under the task's Trash root, never the system temporary directory (AGENTS.md). The tests never
// delete their repositories, so each run leaves them in that Trash root for the user to clear.
const workRoot = path.join(os.homedir(), 'Trash', '3t34-tests')

function tempRepo() {
  fs.mkdirSync(workRoot, { recursive: true })
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-gate-')))
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

function service({ workspaceChanges = recorder() } = {}) {
  fs.mkdirSync(workRoot, { recursive: true })
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'cg-gate-settings-')))
  // The gate starts against a stub host, so the test drives its change observer and its stop hook directly. The
  // session/event listener is captured so a real user message reaches the prompt bound the way the host sends it.
  const listeners = new Map()
  const off = () => () => {}
  const ctx = {
    reflect: { get: name => (name === 'workspaceChanges' ? workspaceChanges : undefined) },
    on: (name, listener) => { listeners.set(name, listener); return off() },
    provide: off, tools: { register: off }, commands: { register: off }, systemPrompt: { section: off }, webServer: { register: off },
  }
  const instance = new CompletionGateService(ctx, {}, { settingsPath: path.join(dir, 'settings.json') })
  instance.__testSettingsDir = dir
  instance.start()
  let published = 0
  instance.publish = (sessionId, type, data) => listeners.get('session/event')({ id: sessionId }, { type, seq: ++published, time: Date.now(), data })
  return instance
}

function agentFor(cwd, id = 'session-1') {
  const steers = [], followups = []
  return { id, session: { header: { cwd }, events: [] }, steer: m => steers.push(m), followup: m => followups.push(m), steers, followups }
}

// Announce one `workspace/changes` event the way the host recorder does, and register the
// summary the service will serve for that sequence. `cwd` is the directory the recorder reports its paths against.
function announce(svc, sessionId, turn, seq, files, cwd) {
  svc.changes.observe({ id: sessionId }, { type: 'turn/start', data: { turn } })
  svc.changes.observe({ id: sessionId }, { type: 'workspace/changes', seq, data: { turn } })
  svc.changeService().entries.set(`${sessionId}:${seq}`, {
    turn, cwd, files, total: files.length, added: files.length, deleted: 0,
  })
}

const file = (p) => ({ path: p, display: p, added: 1, deleted: 0 })

// A catalog with one item, 'unit', so an attestation can state it.
function writeUnitCatalog(repo) {
  fs.mkdirSync(path.join(repo, '.dsh'), { recursive: true })
  const stamp = '2026-11-07T00:00:00.000Z'
  fs.writeFileSync(path.join(repo, '.dsh', 'verification.json'), `${JSON.stringify({ version: 1, items: [{ id: 'unit', name: 'Unit', proves: 'app.js sets value', addedAt: stamp, updatedAt: stamp }] }, null, 2)}\n`)
}

test('a repository with pre-existing dirt does not look changed to the gate', async t => {
  const repo = tempRepo(t)
  // The user's own uncommitted work exists before the session starts and stays untouched.
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\n')
  assert.match(git(repo, ['status', '--porcelain=v1']), /app\.js/, 'precondition: the tree is dirty')

  const svc = service()
  try {
    const agent = agentFor(repo)
    // The turn ran and the recorder announced nothing for it, because the turn changed no file. The dirt above is
    // in the baseline, so no file is attributed to this session and the stop has nothing to say.
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1 } })
    await svc.stopping({ agent, turn: 1 })
    assert.equal(agent.steers.length, 0, 'pre-existing dirt must not produce an advisory')
    const report = await svc.repositoryReport(agent)
    assert.deepEqual(report.repositories, [], 'pre-existing dirt must not be attributed to this session')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a turn the recorder reported changes for is attributed to the session', async t => {
  const repo = tempRepo(t)
  const changes = recorder()
  const svc = service({ workspaceChanges: changes })
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 3, 305, [file('src/feature.js')], repo)
    const report = await svc.repositoryReport(agent)
    assert.deepEqual(
      report.repositories.map(repository => ({ root: repository.root, files: repository.files.map(item => item.absolute) })),
      [{ root: repo, files: [path.join(repo, 'src', 'feature.js')] }],
    )
    assert.deepEqual(changes.announced, [305], 'the summary must be read by the event sequence, not the turn number')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('an absent recorder blocks saying changes cannot be determined', async t => {
  const repo = tempRepo(t)
  const svc = service({ workspaceChanges: null })
  try {
    const agent = agentFor(repo)
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
    await svc.stopping({ agent, turn: 1 })
    assert.equal(agent.steers.length, 1, 'the stop sends one advisory when the recorder is absent')
    assert.match(agent.steers[0].content[0].text, /The host change recorder \(workspaceChanges\) is not available, so the files this turn changed cannot be determined\./)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a documentation-only turn still requires attestation of every changed file', async t => {
  const repo = tempRepo(t)
  const svc = service({ workspaceChanges: recorder() })
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 7, 700, [file('README.md')], repo)
    await svc.stopping({ agent, turn: 7 })
    assert.equal(agent.steers.length, 1, 'the stop sends one advisory for an unattested documentation change')
    const text = agent.steers[0].content[0].text
    assert.match(text, /Attestation: missing\./)
    assert.match(text, /Changed documentation not checked yet:\n- .*README\.md/, 'a prose change is still reviewed, and its path is named')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// Each kind of changed path, sorted by the documentation check: an extension, a plain basename, or neither.
test('the documentation path classifier sorts each kind of changed path', () => {
  assert.equal(isDocumentationPath('README.md'), true)
  assert.equal(isDocumentationPath('notes.txt'), true)
  assert.equal(isDocumentationPath('docs/a.mdx'), true)
  assert.equal(isDocumentationPath('LICENSE'), true)
  assert.equal(isDocumentationPath('CODEOWNERS'), true)
  assert.equal(isDocumentationPath('src/app.js'), false)
  assert.equal(isDocumentationPath('LICENSE.md'), true)
  assert.equal(isDocumentationPath('licence'), true)
})

test('an in-turn check before the turn has any change record is undetermined in the status report', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    // The turn has started but the recorder has announced nothing for it yet.
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
    const status = await svc.statusResult(agent)
    assert.match(status.markdown, /^Notice: The host change record for turn 1 has not been written yet, so the files this turn has changed cannot be determined until the turn stops\.$/m)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a turn keeps its attestation across repeated stops while its files and contents are unchanged', async t => {
  const repo = tempRepo(t)
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\n')
  const svc = service()
  try {
    const agent = agentFor(repo)
    // Each call is one `workspace/changes` announcement, as a stop produces it, for the same file.
    const publish = seq => {
      svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 3 } })
      svc.changes.observe({ id: 'session-1' }, { type: 'workspace/changes', seq, data: { turn: 3 } })
      svc.changeService().entries.set(`session-1:${seq}`, { turn: 3, cwd: repo, files: [file('app.js')], total: 1, added: 1, deleted: 0 })
    }
    writeUnitCatalog(repo)
    const attestation = {
      action: 'attest', repository_root: repo, claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'],
      items: [{ id: 'unit', state: 'passed' }], summary: 'Reviewed app.js.',
    }

    publish(305)
    await svc.stopping({ agent, turn: 3 })
    assert.equal(agent.steers.length, 1, 'stop 1 sends one advisory message until the change set is attested')
    assert.match(agent.steers[0].content[0].text, /Attestation: missing/)
    assert.ok(agent.steers[0].content[0].text.includes(`Root: ${repo}`), 'the advisory names the repository it is about')

    const attested = await svc.attest(agent, attestation)
    assert.equal(attested.pass, true, `attest failed: ${JSON.stringify(attested.blockers)}`)

    publish(307)
    await svc.stopping({ agent, turn: 3 })
    assert.equal(agent.steers.length, 1, 'a repeated stop over an attested, unchanged change set must send nothing')

    fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 3\n')
    publish(309)
    await svc.stopping({ agent, turn: 3 })
    assert.equal(agent.steers.length, 1, 'a changed file inside the prompt must not speak again; the reopen waits for the next real user message')
    // The next real user prompt starts turn 4, which re-arms the one message and names the reopened repository.
    announce(svc, 'session-1', 4, 311, [file('app.js')], repo)
    svc.publish('session-1', 'user/message', { id: 'prompt-4', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] })
    await svc.stopping({ agent, turn: 4 })
    assert.equal(agent.steers.length, 2, 'the next real prompt sends one message about the reopened repository')
    assert.match(agent.steers[1].content[0].text, /Attestation: stale/)
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

  const svc = service()
  try {
    const agent = agentFor(repo)

    // The nested repository is its own repository root, so the pointer is attested under the child root as the path '.'.
    announce(svc, 'session-1', 5, 60, [file('nested')], repo)
    writeUnitCatalog(child)
    const attested = await svc.attest(agent, {
      action: 'attest', repository_root: child, claims: [{ path: '.', decision: 'mine' }], reviewed_code_files: ['.'],
      items: [{ id: 'unit', state: 'passed' }], summary: 'Reviewed the nested repository pointer.',
    })
    assert.equal(attested.pass, true, `attest failed: ${JSON.stringify(attested.blockers)}`)

    // No move: the same child commit keeps the attestation valid at the next stop.
    announce(svc, 'session-1', 5, 61, [file('nested')], repo)
    await svc.stopping({ agent, turn: 5 })
    assert.equal(agent.steers.length, 0, 'an unmoved nested repository must keep its attestation')

    // The child's HEAD moves after attestation, in the same turn.
    fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 2\n')
    git(child, ['add', '-A'])
    git(child, ['commit', '-qm', 'child B'])
    announce(svc, 'session-1', 5, 63, [file('nested')], repo)
    await svc.stopping({ agent, turn: 5 })
    assert.equal(agent.steers.length, 1, 'a moved nested repository pointer must reopen the attestation and send one message')
    assert.match(agent.steers[0].content[0].text, /Attestation: stale/)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// Regression guard for the decided behavior (overseer decision (i)). The host writes no change record for
// a turn that changed nothing, so after the turn has ended an absent record means no changes. The stop check
// and the status report must agree, and the "not written yet" block must not return after the turn ends.
// It fails when an ended turn is read as undetermined, or as still open.
test('an ended turn with no change record reads as no changes: the stop sends nothing and the status shows no notice', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1 } })
    // No workspace/changes event is observed for this turn: the recorder writes nothing for a turn that changed nothing.

    await svc.stopping({ agent, turn: 1 })
    assert.equal(agent.steers.length, 0, 'the stop sends nothing for an ended turn with no change record')

    const report = await svc.repositoryReport(agent)
    assert.deepEqual(report.notices, [], 'an ended turn must not report its record as missing or undetermined')
    assert.deepEqual(report.repositories, [], 'a turn with no change record attributes no repository')
    const status = await svc.statusResult(agent)
    assert.doesNotMatch(status.markdown, /not been written yet/, 'an ended turn must not report its record as not yet written')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a turn that changed nothing reports its stop result once the turn has ended', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 1 } })

    // Before the stop, the recorder has written nothing for this turn, so its change set is undetermined.
    const open = await svc.turnChanges(agent)
    assert.equal(open.determined, false)
    assert.match(open.reason, /has not been written yet/)

    // The stop passes a turn that changed nothing. The stop hook alone does not end the turn, because a
    // steered stop continues the same turn number, so a call made now is still inside the turn.
    await svc.stopping({ agent, turn: 1 })
    assert.equal(agent.steers.length, 0, 'a turn that changed nothing passes its stop')
    assert.equal((await svc.turnChanges(agent)).determined, false)

    // The host ends the turn after its stop. From here a missing record means the turn changed nothing.
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/end', data: { turn: 1 } })
    const ended = await svc.turnChanges(agent)
    assert.equal(ended.determined, true, `the change set must be determined once the turn has ended: ${ended.reason}`)
    assert.deepEqual(ended.files, [])

    // A repository with no changed file owes no claim and no item, so an attest made after the turn ended passes.
    const attested = await svc.attest(agent, { action: 'attest', repository_root: repo })
    assert.deepEqual(attested.problems, [], `attest after the turn ended failed: ${JSON.stringify(attested.problems)}`)
    assert.equal(attested.pass, true)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('a stop after a transient diff read failure rescans the same bytes and names the credential the failed read hid, on the next real prompt', async t => {
  const repo = tempRepo(t)
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\npassword = "hunter2hunter2"\n')
  const changes = recorder()
  // The diff read fails once, at stop 1 only. Every later read succeeds.
  let failures = 1
  changes.diff = async () => {
    if (failures > 0) { failures -= 1; throw new Error('transient read failure') }
    return { kind: 'text', hunks: [{ lines: ['-const value = 1', '+const value = 2', '+password = "hunter2hunter2"'] }] }
  }
  const svc = service({ workspaceChanges: changes })
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
    assert.equal(agent.steers.length, 1, 'stop 1 sends its advisory even though the diff read failed')
    assert.doesNotMatch(agent.steers[0].content[0].text, /Possible hard-coded credential/, 'the failed read hides the credential, so stop 1 cannot name it')
    assert.match(agent.steers[0].content[0].text, /1 changed file could not be read for this scan/, 'stop 1 must name the unread file, since no credential hit exists to carry it')

    // A second stop of the same prompt stays silent even though the diff now reads: the prompt spent its message.
    publish(52)
    await svc.stopping({ agent, turn: 4, signal })
    assert.equal(agent.steers.length, 1, 'a second stop of the same prompt must not speak again, whatever the diff read returns')

    // The next real user message starts turn 5, whose change record is announced first. Same bytes, same listed
    // file, and the diff now reads, so the credential the failed read hid must be named by that prompt's one message.
    svc.changes.observe({ id: 'session-1' }, { type: 'turn/start', data: { turn: 5 } })
    svc.changes.observe({ id: 'session-1' }, { type: 'workspace/changes', seq: 54, data: { turn: 5 } })
    changes.entries.set('session-1:54', { turn: 5, cwd: repo, files: [file('app.js')], total: 1, added: 1, deleted: 0 })
    svc.publish('session-1', 'user/message', { id: 'prompt-5', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] })
    await svc.stopping({ agent, turn: 5, signal })
    assert.equal(agent.steers.length, 2, `the next prompt must rescan the same bytes and send its one message: ${agent.steers.at(-1)?.content[0].text}`)
    const text = agent.steers[1].content[0].text
    assert.match(text, /Possible hard-coded credential or secret/, 'the next prompt must name the credential the failed read hid')
    assert.doesNotMatch(text, /hunter2/, 'the matched value must never be written into the message')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A test script that passes only once a file outside the change set exists, and that writes `ran` each time it
// runs. The marker shows whether a stop or an attest started the script.
function readyCheckRepo(t) {
  const repo = tempRepo(t)
  fs.writeFileSync(path.join(repo, 'check.js'), "require('fs').writeFileSync('ran', 'x')\nprocess.exit(require('fs').existsSync('ready') ? 0 : 1)\n")
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { test: 'node check.js' } }, null, 2) + '\n')
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\n')
  return repo
}

test('a stop starts no project check, so a failing check is neither run nor named at any stop', async t => {
  const repo = readyCheckRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 2, 40, [file('app.js')], repo)
    await svc.stopping({ agent, turn: 2 })
    assert.equal(agent.steers.length, 1, 'stop 1 sends its advisory about the unclaimed file')
    assert.doesNotMatch(agent.steers[0].content[0].text, /failed/, 'a stop must not name a check failure')
    assert.equal(fs.existsSync(path.join(repo, 'ran')), false, 'stop 1 must not run the test script')

    // The environment is fixed and the listed bytes are unchanged. The next stop still runs nothing.
    fs.writeFileSync(path.join(repo, 'ready'), '')
    announce(svc, 'session-1', 2, 42, [file('app.js')], repo)
    await svc.stopping({ agent, turn: 2 })
    assert.equal(fs.existsSync(path.join(repo, 'ran')), false, 'stop 2 must not run the test script after the fix either')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('attest starts no project check, and no stop starts it either', async t => {
  const repo = readyCheckRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 2, 40, [file('app.js')], repo)
    assert.equal(fs.existsSync(path.join(repo, 'ready')), false, 'precondition: the test script would fail without the ready file')
    await svc.attest(agent, { action: 'attest', repository_root: repo })
    assert.equal(fs.existsSync(path.join(repo, 'ran')), false, 'attest must not run the test script')

    await svc.stopping({ agent, turn: 2 })
    assert.equal(fs.existsSync(path.join(repo, 'ran')), false, 'the stop must not run the test script')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A nested repository whose HEAD cannot be read at one stop. The pointer does not move, so the stop must say the gate
// could not check the commit at that stop, without reopening the attestation. Once the HEAD reads, the stop sends nothing.
test('an unreadable nested HEAD is reported at the stop, and the attestation holds once it reads again', async t => {
  const repo = tempRepo(t)
  const child = path.join(repo, 'nested')
  fs.mkdirSync(child)
  git(child, ['init', '-q', '.'])
  git(child, ['config', 'user.email', 'test@example.com'])
  git(child, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 1\n')
  git(child, ['add', '-A'])
  git(child, ['commit', '-qm', 'child A'])

  const svc = service()
  try {
    const agent = agentFor(repo)
    const headFile = path.join(child, '.git', 'HEAD')
    const savedHead = fs.readFileSync(headFile, 'utf8')

    // The nested pointer is a file of its own repository (a directory with a .git entry owns itself), so the attest
    // names the child root and the pointer is the child root itself: the path '.'.
    writeUnitCatalog(child)
    announce(svc, 'session-1', 1, 60, [file('nested')], repo)
    const attested = await svc.attest(agent, {
      action: 'attest', repository_root: child, claims: [{ path: '.', decision: 'mine' }], reviewed_code_files: ['.'],
      items: [{ id: 'unit', state: 'passed' }], summary: 'Reviewed the nested repository pointer.',
    })
    assert.equal(attested.pass, true, `attest failed: ${JSON.stringify(attested.blockers)}`)

    // Stop 1: the child HEAD reads and the pointer is unchanged, so the stop passes.
    announce(svc, 'session-1', 1, 61, [file('nested')], repo)
    await svc.stopping({ agent, turn: 1 })
    assert.equal(agent.steers.length, 0, 'stop 1 passes at the attested commit')

    // Stop 2: git cannot read the child HEAD, because HEAD names a branch that does not exist. The pointer did not move.
    fs.writeFileSync(headFile, 'ref: refs/heads/missing-for-test\n')
    announce(svc, 'session-1', 1, 62, [file('nested')], repo)
    await svc.stopping({ agent, turn: 1 })
    assert.equal(agent.steers.length, 1, 'stop 2 sends one notice while the nested HEAD cannot be read')
    assert.match(agent.steers[0].content[0].text, /Nested repository nested: could not read its HEAD at this stop/)
    assert.doesNotMatch(agent.steers[0].content[0].text, /Attestation: (missing|stale)/, 'an unreadable HEAD must keep the identity of the path, so the attestation stays current')

    // The status report names the same read failure, and the attested child repository still reads as complete.
    const during = await svc.repositoryReport(agent)
    assert.deepEqual(during.notices, ['Nested repository nested: could not read its HEAD.'])
    const childEntry = during.repositories.find(repository => repository.root === child)
    assert.equal(childEntry?.complete, true, 'the attested child keeps its identity while its HEAD is unreadable')

    // Stop 3: the HEAD reads again at the same commit, so the stop sends nothing new.
    fs.writeFileSync(headFile, savedHead)
    announce(svc, 'session-1', 1, 63, [file('nested')], repo)
    await svc.stopping({ agent, turn: 1 })
    assert.equal(agent.steers.length, 1, `stop 3 must send nothing once the nested HEAD reads again: ${agent.steers.at(-1)?.content[0].text}`)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// The first HEAD read of a nested repository fails, so no earlier HEAD stands in for it. An attest made in that
// window must bind nothing: it throws with its own refusal message, and one attest after recovery passes.
test('an attest during a first nested HEAD read failure binds nothing, and one attest after recovery passes', async t => {
  const repo = tempRepo(t)
  const child = path.join(repo, 'nested')
  fs.mkdirSync(child)
  git(child, ['init', '-q', '.'])
  git(child, ['config', 'user.email', 'test@example.com'])
  git(child, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 1\n')
  git(child, ['add', '-A'])
  git(child, ['commit', '-qm', 'child A'])

  const headFile = path.join(child, '.git', 'HEAD')
  const savedHead = fs.readFileSync(headFile, 'utf8')
  // HEAD names a branch that does not exist, so the first-ever read of this path fails.
  fs.writeFileSync(headFile, 'ref: refs/heads/missing-for-test\n')

  const svc = service()
  try {
    const agent = agentFor(repo)
    const attestation = {
      action: 'attest', repository_root: child, claims: [{ path: '.', decision: 'mine' }], reviewed_code_files: ['.'],
      items: [{ id: 'unit', state: 'passed' }], summary: 'Reviewed the nested repository pointer.',
    }

    announce(svc, 'session-1', 5, 80, [file('nested')], repo)
    await assert.rejects(svc.attest(agent, attestation), /Nested repository nested has no readable HEAD yet, so nothing is attested/)
    // The refused call bound nothing: the child repository is listed with no attestation.
    const refused = await svc.repositoryReport(agent)
    const childEntry = refused.repositories.find(repository => repository.root === child)
    assert.equal(childEntry?.attestation, null, 'a refused attest must bind nothing to the placeholder identity')

    fs.writeFileSync(headFile, savedHead)
    writeUnitCatalog(child)
    announce(svc, 'session-1', 5, 81, [file('nested')], repo)
    const attested = await svc.attest(agent, attestation)
    assert.equal(attested.pass, true, `one attest after recovery must pass: ${JSON.stringify(attested.blockers)}`)

    announce(svc, 'session-1', 5, 82, [file('nested')], repo)
    await svc.stopping({ agent, turn: 5 })
    assert.equal(agent.steers.length, 0, `the stop after that attest must pass: ${agent.steers.at(-1)?.content[0].text}`)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A nested repository with no commit yet. Git cannot read its HEAD, so the gate reports it as unreadable, the same as
// a broken HEAD. The host does not list such a repository, so the test announces it directly.
test('an unborn nested repository is reported as unreadable until it has a commit', async t => {
  const repo = tempRepo(t)
  const child = path.join(repo, 'nested')
  fs.mkdirSync(child)
  git(child, ['init', '-q', '.'])
  const svc = service()
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 1, 90, [file('nested')], repo)
    const blocked = await svc.repositoryReport(agent)
    assert.deepEqual(blocked.notices, ['Nested repository nested: could not read its HEAD.'], 'an unborn nested repository must be named as unreadable')

    git(child, ['config', 'user.email', 'test@example.com'])
    git(child, ['config', 'user.name', 'test'])
    fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 1\n')
    git(child, ['add', '-A'])
    git(child, ['commit', '-qm', 'child A'])
    announce(svc, 'session-1', 1, 91, [file('nested')], repo)
    const committed = await svc.repositoryReport(agent)
    assert.deepEqual(committed.notices, [], 'a committed nested repository reads its HEAD, so no notice is left')
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

  const svc = service()
  try {
    const agent = agentFor(repo)
    // The listed directory owns itself, so the attest names the child root and the pointer is the path '.'.
    writeUnitCatalog(child)
    announce(svc, 'session-1', 6, 70, [file(listed)], repo)
    const attested = await svc.attest(agent, {
      action: 'attest', repository_root: child, claims: [{ path: '.', decision: 'mine' }], reviewed_code_files: ['.'],
      items: [{ id: 'unit', state: 'passed' }], summary: 'Reviewed the nested repository pointer.',
    })
    assert.equal(attested.pass, true, `attest failed: ${JSON.stringify(attested.blockers)}`)
    announce(svc, 'session-1', 6, 71, [file(listed)], repo)
    await svc.stopping({ agent, turn: 6 })
    assert.equal(agent.steers.length, 0, 'precondition: the unmoved pointer passes')

    // The child's HEAD moves after attestation, in the same turn.
    fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 2\n')
    git(child, ['add', '-A'])
    git(child, ['commit', '-qm', 'child B'])
    assert.notEqual(await contentKey(repo, listed), `head:${headA}`, 'the moved pointer changes the key')
    announce(svc, 'session-1', 6, 73, [file(listed)], repo)
    await svc.stopping({ agent, turn: 6 })
    assert.equal(agent.steers.length, 1, 'a moved pointer under a newline path must reopen the attestation and send one message')
    assert.match(agent.steers[0].content[0].text, /Attestation: stale/)

    const report = await svc.repositoryReport(agent)
    const childEntry = report.repositories.find(repository => repository.root === child)
    assert.equal(childEntry?.complete, false, 'the status must not show a moved pointer under a newline path as complete')
    assert.match(childEntry.problems.join(' '), /No current attestation for this repository/)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A change record that was announced and then lost. The stop cannot tell which files the turn changed, so it says so.
test('an announced change record that has vanished leaves its turn undetermined at the stop', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 3, 310, [file('app.js')], repo)
    svc.changeService().entries.delete('session-1:310')
    await svc.stopping({ agent, turn: 3 })
    assert.equal(agent.steers.length, 1, 'the stop sends one advisory when the announced record is gone')
    assert.match(agent.steers[0].content[0].text, /The host change record for turn 3 \(sequence 310\) is no longer available, so the files this turn changed cannot be determined\./)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A change record that is announced but whose read throws. The stop reports the read failure rather than reading the turn as unchanged.
test('a host change record that cannot be read leaves its turn undetermined at the stop', async t => {
  const repo = tempRepo(t)
  const changes = recorder()
  const svc = service({ workspaceChanges: changes })
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 3, 320, [file('app.js')], repo)
    changes.summary = () => { throw new Error('summary read broke') }
    await svc.stopping({ agent, turn: 3 })
    assert.equal(agent.steers.length, 1, 'the stop sends one advisory when the record read throws')
    assert.match(agent.steers[0].content[0].text, /Reading the host change record for turn 3 failed: summary read broke\./)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

// A subagent session is not covered by the host change recorder, so its turn's changes cannot be determined. The status
// report says so rather than reading the turn as unchanged.
test('a subagent session is reported as not covered by the host change recorder', async t => {
  const repo = tempRepo(t)
  const svc = service()
  try {
    const agent = agentFor(repo, 'subagent-1')
    agent.session.header.parentSession = 'session-1'
    svc.changes.observe({ id: 'subagent-1' }, { type: 'turn/start', data: { turn: 1 } })
    const status = await svc.statusResult(agent)
    assert.match(status.markdown, /Notice: The host change recorder does not record this session, so the files turn 1 changed cannot be determined\./)
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})
