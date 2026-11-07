import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompletionGateService } from '../lib/index.js'
import { userMessage } from './user-message.mjs'

// The stop message of ticket personal#3nm5. At a stop the gate sends at most one advisory steer, covering every repository
// the session changed that still has unfinished work. The stop path runs no project check, so a test script in a
// repository never runs during a stop. These tests drive the service through its own seam, a stub host that feeds
// session events and a change record, and read the steers it sends. Fixtures live under the task's Trash root.

const TURN = 3
const INTRO = 'new to this session'
const workRoot = path.join(os.homedir(), 'Trash', '3nm5-tests')

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// A committed repository with one file. Each call makes a new directory, so tests never share a tree.
function tempRepo(label) {
  fs.mkdirSync(workRoot, { recursive: true })
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, `${label}-`)))
  git(dir, ['init', '-q', '.'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(dir, 'app.js'), 'const value = 1\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'init'])
  return dir
}

// A repository whose app.js differs from its commit, so it is a changed repository.
function changedRepo(label) {
  const dir = tempRepo(label)
  fs.writeFileSync(path.join(dir, 'app.js'), 'const value = 2\n')
  return dir
}

// A fake host recorder. `summary` serves one announced sequence, and `diff` serves the added lines of each listed file.
function recorder() {
  const entries = new Map()
  const diffs = new Map()
  return {
    entries,
    diffs,
    summary(sessionId, seq) { return entries.get(`${sessionId}:${seq}`) },
    async diff(sessionId, seq, index) {
      const lines = diffs.get(`${sessionId}:${seq}`)?.[index]
      return lines === undefined ? undefined : { kind: 'text', hunks: [{ lines }] }
    },
  }
}

// The gate on a stub host. Turn events reach it through the session/event hook, as the host publishes them.
function service({ workspaceChanges = recorder(), settings = {} } = {}) {
  fs.mkdirSync(workRoot, { recursive: true })
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(workRoot, 'settings-')))
  const listeners = new Map()
  const off = () => () => {}
  const ctx = {
    reflect: { get: name => (name === 'workspaceChanges' ? workspaceChanges : undefined) },
    on: (name, listener) => { listeners.set(name, listener); return off() },
    provide: off, tools: { register: off }, commands: { register: off }, systemPrompt: { section: off }, webServer: { register: off },
  }
  const instance = new CompletionGateService(ctx, settings, { settingsPath: path.join(dir, 'settings.json') })
  instance.start()
  let published = 0
  // Publishes one event the way the host does, and returns the sequence the event was given.
  instance.publish = (agent, type, data) => {
    const seq = ++published
    listeners.get('session/event')({ id: agent.id }, { type, seq, time: Date.now(), data })
    return seq
  }
  return instance
}

function agentFor(cwd, { id = 'session-1', subagent = false } = {}) {
  const steers = [], followups = []
  const header = subagent ? { cwd, parentSession: 'root', delegationDepth: 1 } : { cwd }
  return { id, session: { header }, steer: m => steers.push(m), followup: m => followups.push(m), steers, followups }
}

// The host opens every turn with `turn/start`, then appends the batch of queued messages for that turn, the real user
// prompt included, before the first step. The gate reads that prompt on the `session/event` hook, so the harness
// delivers the same sequence here and a stop never runs in a state the host cannot produce.
function begin(svc, agent, turn = TURN) {
  svc.publish(agent, 'turn/start', { turn })
  svc.publish(agent, 'user/message', userMessage(agent.id, turn))
}

// Announces one turn's change record the way the host does: the event, then the summary it serves for that sequence.
function announce(svc, agent, { turn = TURN, cwd, files, total = files.length, diffs = null }) {
  const seq = svc.publish(agent, 'workspace/changes', { turn })
  svc.changeService().diffs.delete(`${agent.id}:${seq}`)
  svc.changeService().entries.set(`${agent.id}:${seq}`, {
    turn, cwd, files: files.map(p => ({ path: p, display: p, added: 1, deleted: 0 })), total, added: files.length, deleted: 0,
  })
  if (diffs) svc.changeService().diffs.set(`${agent.id}:${seq}`, diffs)
  return seq
}

// A catalog with the given item ids. Each item carries its name and what passing it proves.
function writeCatalog(repo, ids) {
  fs.mkdirSync(path.join(repo, '.dsh'), { recursive: true })
  const stamp = '2026-11-07T00:00:00.000Z'
  const items = ids.map(id => ({ id, name: id, proves: `${id} holds`, addedAt: stamp, updatedAt: stamp }))
  fs.writeFileSync(path.join(repo, '.dsh', 'verification.json'), `${JSON.stringify({ version: 1, items }, null, 2)}\n`)
}

function stop(svc, agent, turn = TURN) {
  return svc.stopping({ agent, turn, signal: new AbortController().signal })
}

// A real user prompt reaches the hook as the turn's `user/message` with the host's `user` source kind. `begin`
// already delivers the prompt that opens a turn, so this publishes only the extra prompts a test needs.
function prompt(svc, agent, turn = TURN) {
  svc.publish(agent, 'user/message', userMessage(agent.id, turn))
}

function steerText(steer) { return steer.content.map(part => part.text).join('') }

// The advisory shape every message keeps: it says nothing is stopped and never uses blocking wording.
function assertAdvisory(text) {
  assert.match(text, /nothing is stopped/i, 'the message must say nothing is stopped')
  assert.doesNotMatch(text, /blocked|block/i, 'the message must not use blocking wording')
}

test('two repositories with unfinished work produce one steer that names both', async () => {
  const a = changedRepo('two-a')
  const b = changedRepo('two-b')
  const svc = service()
  const agent = agentFor(a)
  begin(svc, agent)
  announce(svc, agent, { cwd: a, files: ['app.js', path.join(b, 'app.js')] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'one stop with two unfinished repositories must send exactly one steer')
  const text = steerText(agent.steers[0])
  assert.ok(text.includes(`Root: ${a}`), `the steer must name the first root: ${text}`)
  assert.ok(text.includes(`Root: ${b}`), `the steer must name the second root: ${text}`)
  assert.ok(text.includes(path.join(a, 'app.js')), 'the steer must list the first repository\'s changed file')
  assert.ok(text.includes(path.join(b, 'app.js')), 'the steer must list the second repository\'s changed file')
})

test('several unfinished repositories produce one steer per stop', async () => {
  const a = changedRepo('several-a')
  const b = changedRepo('several-b')
  const c = changedRepo('several-c')
  const svc = service()
  const agent = agentFor(a)
  begin(svc, agent)
  announce(svc, agent, { cwd: a, files: ['app.js', path.join(b, 'app.js'), path.join(c, 'app.js')] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'three unfinished repositories must still produce exactly one steer')
  const text = steerText(agent.steers[0])
  for (const root of [a, b, c]) assert.ok(text.includes(`Root: ${root}`), `the steer must name ${root}`)
})

test('a fully attested repository with no unfinished work produces no steer', async () => {
  const repo = changedRepo('attested')
  writeCatalog(repo, ['unit'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  const result = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(result.pass, true, `precondition: the attestation must complete the repository: ${result.problems.join(' | ')}`)
  await stop(svc, agent)
  assert.equal(agent.steers.length, 0, 'a complete repository must not produce a steer')
})

test('the introduction appears in the first message for a repository and never again', async () => {
  const repo = changedRepo('intro')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  prompt(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'the first prompt sends the first message')
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a later stop of the same prompt is silent')
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the next real prompt sends one message')
  const first = steerText(agent.steers[0])
  const second = steerText(agent.steers[1])
  assert.ok(first.includes(INTRO), 'the first message must introduce the repository')
  assert.ok(first.includes(path.join(repo, '.dsh', 'verification.json')), 'the introduction must point at the catalog')
  assert.ok(first.includes('Attestation: missing'), 'a repository never attested must say its attestation is missing')
  assert.ok(!second.includes(INTRO), 'the second message must not repeat the introduction')
  assert.ok(second.includes(`Root: ${repo}`), 'the second message must still name the repository')
})

test('a silent stop does not spend the repository introduction', async () => {
  const repo = changedRepo('intro-wait')
  const svc = service({ settings: { enabled: false } })
  const agent = agentFor(repo)
  begin(svc, agent)
  prompt(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 0, 'precondition: a disabled gate sends nothing, so nothing is introduced')
  svc.updateSettings({ enabled: true })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'the first delivered message must come after the gate is enabled')
  assert.ok(steerText(agent.steers[0]).includes(INTRO), 'the introduction must reach the first delivered message')
})

test('an assumed item shows its reason and is labelled a promise, not a run', async () => {
  const repo = changedRepo('assumed')
  writeCatalog(repo, ['browser'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  const result = await svc.attest(agent, {
    repository_root: repo,
    items: [{ id: 'browser', state: 'assumed', reason: 'no display is attached to this host' }],
  })
  assert.equal(result.pass, false, 'precondition: app.js is still unclaimed, so the repository stays open')
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  assert.ok(text.includes('no display is attached to this host'), `the assumed reason must be shown: ${text}`)
  assert.match(text, /assumed, not run/, 'an assumed item must be labelled as not run')
  assert.match(text, /promise, not a pass/, 'an assumed item must be labelled as a promise')
})

test('an item marked unrelated to the session is omitted from the message', async () => {
  const repo = changedRepo('unrelated-omitted')
  writeCatalog(repo, ['unit', 'browser'])
  fs.writeFileSync(path.join(repo, 'other.js'), 'const other = 1\n')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js', 'other.js'] })
  const result = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'],
    items: [{ id: 'unit', state: 'passed' }, { id: 'browser', state: 'unrelated' }],
  })
  assert.equal(result.pass, false, 'precondition: other.js is unclaimed, so the repository stays open')
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  assert.ok(text.includes('- unit (unit): passed'), `the item that bears on the session is listed: ${text}`)
  assert.ok(text.includes(path.join(repo, 'other.js')), 'precondition: the unclaimed file is listed')
  assert.doesNotMatch(text, /browser/, 'the unrelated item is omitted from the message')
})

test('a repository whose items are all unrelated contributes nothing to the message', async () => {
  const repo = changedRepo('all-unrelated')
  writeCatalog(repo, ['unit', 'browser'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  const result = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'],
    items: [{ id: 'unit', state: 'unrelated' }, { id: 'browser', state: 'unrelated' }],
  })
  assert.equal(result.pass, true, `precondition: nothing else is unfinished: ${result.problems.join(' | ')}`)
  await stop(svc, agent)
  assert.equal(agent.steers.length, 0, 'a repository with only unrelated items left must contribute nothing')
})

// The message when no item is marked unrelated: every item is listed with its state, in catalog order, exactly as before.
test('with no item marked unrelated the message lists every item with its state', async () => {
  const repo = changedRepo('no-unrelated')
  writeCatalog(repo, ['unit', 'browser', 'smoke'])
  fs.writeFileSync(path.join(repo, 'other.js'), 'const other = 1\n')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js', 'other.js'] })
  await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'],
    items: [{ id: 'unit', state: 'passed' }, { id: 'browser', state: 'assumed', reason: 'no display is attached' }],
  })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const lines = steerText(agent.steers[0]).split('\n')
  const at = lines.indexOf('Verification items:')
  assert.ok(at >= 0, 'precondition: the message lists the verification items')
  const listed = []
  for (let index = at + 1; index < lines.length && lines[index].startsWith('- '); index += 1) listed.push(lines[index])
  assert.deepEqual(listed, [
    '- unit (unit): passed',
    '- browser (browser): assumed, not run. This is a promise, not a pass. Reason: no display is attached',
    '- smoke (smoke): unfinished, no state reported yet',
  ])
})

test('the message says it is advisory, nothing is stopped, and it never says BLOCKED', async () => {
  const repo = changedRepo('advisory')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  assert.match(text, /advisory/i, 'the message must say it is advisory')
  assert.match(text, /nothing is stopped/i, 'the message must say nothing is stopped')
  assert.match(text, /no project verification check ran/, 'the header must say no project verification check ran')
  assert.doesNotMatch(text, /gate ran no check/, 'the header must not claim the gate ran no check')
  assert.doesNotMatch(text, /blocked|block/i, 'the message must not use blocking wording')
})

test('one prompt speaks once, a changed change set waits, and the next prompt speaks again', async () => {
  const repo = changedRepo('bound')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  prompt(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  for (let i = 0; i < 4; i += 1) await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'the prompt speaks once, whatever the number of stops')
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 3\n')
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a changed file inside the prompt must not speak again')
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the next real prompt speaks again')
})

test('a repository changed after its attestation says its attestation is stale', async () => {
  const repo = changedRepo('stale')
  writeCatalog(repo, ['unit'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  const result = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(result.pass, true, `precondition: the attestation must complete the repository: ${result.problems.join(' | ')}`)
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 3\n')
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a change after the attestation reopens the repository, so a message speaks')
  const text = steerText(agent.steers[0])
  assert.match(text, /Attestation: stale/, 'the attestation must be reported as stale')
  assert.match(text, /dropped/, 'the stale attestation must say it was dropped')
})

test('a changed file in a repository with an unreadable catalog is named, and the catalog is not listed as empty', async () => {
  const repo = changedRepo('unreadable')
  fs.mkdirSync(path.join(repo, '.dsh'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.dsh', 'verification.json'), '{ not json')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  assert.match(text, /Catalog unreadable/, 'an unreadable catalog must be named as unreadable')
  assert.match(text, /cannot be read/, 'the introduction must say the catalog cannot be read')
  assert.doesNotMatch(text, /Read it, adopt/, 'an unreadable catalog must not be told to read and adopt items')
  const next = text.split('\n').find(line => line.startsWith('Next:'))
  assert.ok(next, 'the message must carry a next step')
  assert.match(next, /^Next: repair the verification catalog/, 'the next step must repair the catalog before any registration')
})

test('an absent host recorder gives one short undetermined message', async () => {
  const svc = service({ workspaceChanges: null })
  const agent = agentFor(tempRepo('absent'))
  begin(svc, agent)
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'an undetermined change set must produce one message')
  assert.match(steerText(agent.steers[0]), /cannot be determined/)
  assertAdvisory(steerText(agent.steers[0]))
})

test('a gated subagent session gives one undetermined message', async () => {
  const svc = service({ settings: { gateSubagents: true } })
  const agent = agentFor(tempRepo('subagent'), { subagent: true })
  begin(svc, agent)
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a subagent the recorder excludes must produce one message')
  assert.match(steerText(agent.steers[0]), /does not record this session/)
  assertAdvisory(steerText(agent.steers[0]))
})

test('an announced record whose summary is missing gives one undetermined message', async () => {
  const svc = service()
  const agent = agentFor(tempRepo('missing-summary'))
  begin(svc, agent)
  svc.publish(agent, 'workspace/changes', { turn: TURN })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'an announced record that cannot be read must produce one message')
  assert.match(steerText(agent.steers[0]), /no longer available/)
  assertAdvisory(steerText(agent.steers[0]))
})

test('a truncated record gives one undetermined message', async () => {
  const repo = changedRepo('truncated')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'], total: 2 })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a truncated record must produce one message')
  assert.match(steerText(agent.steers[0]), /carries only 1 of them/)
  assertAdvisory(steerText(agent.steers[0]))
})

test('a change set over the changed-file bound gives one undetermined message', async () => {
  const repo = tempRepo('over-bound')
  const files = Array.from({ length: 11 }, (_, i) => `file${i}.js`)
  const svc = service({ settings: { maxChangedFiles: 10 } })
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a change set over the bound must produce one message')
  assert.match(steerText(agent.steers[0]), /over the configured limit of 10/)
  assertAdvisory(steerText(agent.steers[0]))
})

test('an ended turn with no change announcement produces no message', async () => {
  const repo = tempRepo('ended')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  svc.publish(agent, 'turn/end', { turn: TURN })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 0, 'a covered turn that changed nothing must send nothing')
})

test('a credential pattern in the added lines is named by its rule, and its value is not echoed', async () => {
  const repo = changedRepo('credential')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'], diffs: [['+password = "hunter2hunter2"']] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  assert.ok(text.includes('Possible hard-coded credential or secret'), `the rule must be named: ${text}`)
  assert.doesNotMatch(text, /hunter2/, 'the matched value must never be written into the message')
})

test('the stop runs no project check: a test script that writes a marker leaves it absent', async () => {
  const repo = changedRepo('no-check')
  const marker = path.join(repo, 'check-ran.marker')
  fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({
    name: 'probe', version: '1.0.0', scripts: { test: `node -e "require('fs').writeFileSync('${marker}','ran')"` },
  }, null, 2)}\n`)
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'the stop must still send its message')
  assert.equal(fs.existsSync(marker), false, 'the stop must not start the project test script')
})

test('a later turn without a real user prompt does not re-arm the advisory', async () => {
  const repo = changedRepo('bound-turn')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the prompt spent its one message')
  // A later turn whose only user message carries another producer's kind, as a recovery followup or injected
  // context does. `begin` opens the turn but delivers no real prompt, so the spent message stays spent.
  svc.publish(agent, 'turn/start', { turn: 4 })
  svc.publish(agent, 'user/message', { id: 'plugin-note', role: 'user', source: { kind: 'plugin:other' }, content: [{ type: 'text', text: 'context' }] })
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 1, 'a turn the user did not start must not re-arm the message')
})

test('a message for 51 unfinished files names every file, the last one included', async () => {
  const repo = tempRepo('many-files')
  const files = Array.from({ length: 51 }, (_, i) => `file${i}.js`)
  for (const file of files) fs.writeFileSync(path.join(repo, file), 'const x = 1\n')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.startsWith('Changed files not claimed yet'))
  assert.ok(start >= 0, 'precondition: the message must list the unclaimed files')
  const unclaimed = []
  for (let i = start + 1; i < lines.length && lines[i].startsWith('- '); i += 1) unclaimed.push(lines[i])
  assert.equal(unclaimed.length, 51, 'every unclaimed file must be listed, not summarized')
  assert.ok(unclaimed.every(line => line.startsWith(`- ${repo}`)), 'every unclaimed line must be a path, with no count line')
  assert.ok(unclaimed.some(line => line.endsWith('file50.js')), 'the last unclaimed file must be listed')
})

test('an item with no state reported is unfinished, not described as an unstated state', async () => {
  const repo = changedRepo('unreported-item')
  writeCatalog(repo, ['unit'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  const text = steerText(agent.steers[0])
  assert.match(text, /unit \(unit\): unfinished, no state reported yet/, 'an unreported item must read as unfinished')
  assert.doesNotMatch(text, /no state stated yet/, 'the old wording must be gone')
})

test('a changed file whose added lines could not be read is named even when no credential hit exists', async () => {
  const repo = changedRepo('gap-only')
  writeCatalog(repo, ['unit'])
  const changes = recorder()
  changes.diff = async () => { throw new Error('transient read failure') }
  const svc = service({ workspaceChanges: changes })
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  const result = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(result.pass, true, `precondition: the repository must be complete: ${result.problems.join(' | ')}`)
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'an unread file must send a message even when the repository is complete')
  const text = steerText(agent.steers[0])
  assert.match(text, /1 changed file could not be read for this scan/, 'the heading must count the unread file')
  assert.match(text, /^- app\.js: transient read failure$/m, 'the unread file must be named by its path, with its read error')
  assertAdvisory(text)
})

test('with the credential scan off, an unread file sends nothing when the repository is complete', async () => {
  const repo = changedRepo('gap-scan-off')
  writeCatalog(repo, ['unit'])
  const changes = recorder()
  changes.diff = async () => { throw new Error('transient read failure') }
  const svc = service({ workspaceChanges: changes, settings: { securityScan: false } })
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  const result = await svc.attest(agent, {
    repository_root: repo,
    claims: [{ path: 'app.js', decision: 'mine' }],
    reviewed_code_files: ['app.js'],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(result.pass, true, `precondition: the repository must be complete: ${result.problems.join(' | ')}`)
  await stop(svc, agent)
  assert.equal(agent.steers.length, 0, 'with no scan running, a gap must not claim that a scan was incomplete')
})

test('an attested nested repository whose HEAD becomes unreadable on a later stop with no change is named', async () => {
  const repo = tempRepo('nested-later')
  const child = path.join(repo, 'nested')
  fs.mkdirSync(child)
  git(child, ['init', '-q', '.'])
  git(child, ['config', 'user.email', 'test@example.com'])
  git(child, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(child, 'lib.js'), 'module.exports = 1\n')
  git(child, ['add', '-A'])
  git(child, ['commit', '-qm', 'child'])
  writeCatalog(child, ['unit'])
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 1)
  announce(svc, agent, { turn: 1, cwd: repo, files: [child] })
  const result = await svc.attest(agent, {
    repository_root: child,
    claims: [{ path: '.', decision: 'mine' }],
    reviewed_code_files: ['.'],
    items: [{ id: 'unit', state: 'passed' }],
  })
  assert.equal(result.pass, true, `precondition: the nested repository must be complete: ${result.problems.join(' | ')}`)
  await stop(svc, agent, 1)
  assert.equal(agent.steers.length, 0, 'precondition: the attested nested repository is complete at its commit')
  // Turn 2 ends with no change record. Git can no longer read the nested HEAD, and the pointer did not move.
  begin(svc, agent, 2)
  svc.publish(agent, 'turn/end', { turn: 2 })
  fs.writeFileSync(path.join(child, '.git', 'HEAD'), 'ref: refs/heads/missing-for-test\n')
  await stop(svc, agent, 2)
  assert.equal(agent.steers.length, 1, 'a later stop must name the nested HEAD it could not read')
  const text = steerText(agent.steers[0])
  assert.match(text, /Nested repository .*: could not read its HEAD at this stop/, 'the notice must say the nested HEAD could not be read at this stop')
  assert.ok(text.includes(child), 'the notice must name the nested repository by its path')
  assertAdvisory(text)
})

// A file the host cannot compare as text serves no lines, so the scan never reads its added lines. The gate saw that gap,
// so the gap line must name it, with a complete repository, exactly as a thrown read does.
for (const kind of ['binary', 'oversized']) {
  test(`a changed file whose added lines come back ${kind} is named as unread, even when no credential hit exists`, async () => {
    const repo = changedRepo(`gap-${kind}`)
    writeCatalog(repo, ['unit'])
    const changes = recorder()
    changes.diff = async () => ({ kind, path: 'app.js', display: 'app.js' })
    const svc = service({ workspaceChanges: changes })
    const agent = agentFor(repo)
    begin(svc, agent)
    announce(svc, agent, { cwd: repo, files: ['app.js'] })
    const result = await svc.attest(agent, {
      repository_root: repo,
      claims: [{ path: 'app.js', decision: 'mine' }],
      reviewed_code_files: ['app.js'],
      items: [{ id: 'unit', state: 'passed' }],
    })
    assert.equal(result.pass, true, `precondition: the repository must be complete: ${result.problems.join(' | ')}`)
    await stop(svc, agent)
    assert.equal(agent.steers.length, 1, `the ${kind} file must send a message even when the repository is complete`)
    const text = steerText(agent.steers[0])
    assert.match(text, /1 changed file could not be read for this scan/, 'the heading must count the unread file')
    assert.match(text, new RegExp(`^- app\\.js: ${kind}$`, 'm'), `the advisory must list app.js on its own line with its kind ${kind}`)
    assertAdvisory(text)
  })
}

test('a turn whose changed files cannot be attributed to a repository is named at the stop, and no check runs', async () => {
  const repo = changedRepo('attribution-failure')
  writeCatalog(repo, ['unit'])
  const svc = service()
  svc.repositories.merge = async () => { throw new Error('simulated EIO') }
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a failed attribution must send a message, because the gate saw the failure')
  const text = steerText(agent.steers[0])
  assert.match(text, /could not attribute the changed files of turn 3 to their repositories: simulated EIO/, 'the message must name the turn and the failure')
  assert.match(text, /no project verification check ran/i, 'the message must say no check ran')
  assertAdvisory(text)
})

// Ticket personal#x9af: the advisory speaks at most once since the last real user message. The host dispatches the
// stop hook at every attempt to end the turn, and the gate's own steer continues the turn, so a per-stop message
// repeats. The prompt is the turn a real user message starts; its source kind tells it apart from this plugin's
// steer and from the premature-stop recovery followup, which starts a turn of its own.

test('a user prompt with unfinished work sends exactly one advisory across every stop of its turn', async () => {
  const repo = changedRepo('one-per-prompt')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  prompt(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  for (let i = 0; i < 4; i += 1) await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'one prompt must produce at most one advisory, however often the model tries to end')
})

test('a second stop of the same prompt sends nothing even when the change set changed', async () => {
  const repo = changedRepo('same-prompt-new-set')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  prompt(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'precondition: the first stop sends the prompt advisory')
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 3\n')
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a changed file inside one prompt must not speak twice')
  fs.writeFileSync(path.join(repo, 'app2.js'), 'const extra = 1\n')
  announce(svc, agent, { cwd: repo, files: ['app.js', 'app2.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'a new file inside one prompt must not speak twice')
})

test('a new real user message re-arms exactly one message', async () => {
  const repo = changedRepo('rearm')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  for (let i = 0; i < 3; i += 1) await stop(svc, agent, 3)
  const before = agent.steers.length
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, before + 1, 'a new real user message must re-arm exactly one advisory')
  assert.equal(before, 1, 'precondition: the first prompt has spent its one message')
})

test('the gate\'s own steered continuation does not re-arm the advisory', async () => {
  const repo = changedRepo('steer-no-rearm')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  prompt(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1)
  // A steer stays in the same turn, and the host appends its message with this plugin's source.
  svc.publish(agent, 'user/message', {
    id: 'steered', role: 'user', source: { kind: 'plugin:dsh-completion-gate' },
    content: [{ type: 'text', text: steerText(agent.steers[0]) }],
  })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'the gate\'s own steer must not re-arm its one message')
})

test('a premature-stop recovery turn does not re-arm the advisory, even with the message unspent', async () => {
  const repo = changedRepo('followup-no-rearm')
  const svc = service()
  const agent = agentFor(repo)
  // The real prompt changes nothing, so its own stop has nothing to say and the one message stays unspent.
  begin(svc, agent, 3)
  // The model ends turn 3 while saying work is pending, so the guard queues its recovery followup straight away.
  svc.publish(agent, 'assistant/message', { turn: 3, message: { role: 'assistant', content: [{ type: 'text', text: 'Next I will run the suite.' }] } })
  await stop(svc, agent, 3)
  assert.equal(agent.followups.length, 1, 'precondition: a future-intent stop queues one recovery followup')
  assert.equal(agent.steers.length, 0, 'precondition: the prompt message is still unspent')
  // The followup opens the next host turn, and its message carries this plugin's source, so no real prompt starts.
  // That turn owes real work, so a bound keyed on the turn alone would speak here. The prompt is what bounds the
  // message, so the recovery turn speaks the prompt's one message rather than a second one.
  svc.publish(agent, 'turn/start', { turn: 4 })
  const queued = svc.publish(agent, 'user/message', {
    id: 'followup', role: 'user', source: { kind: 'plugin:dsh-completion-gate' },
    content: [{ type: 'text', text: 'PREMATURE STOP RECOVERY: Continue the unfinished task.' }],
  })
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  assert.ok(Number.isInteger(queued), 'precondition: the followup message was published')
  assert.match(svc.state(agent).promptId, /^prompt-session-1-3/, 'precondition: the followup did not start a prompt')
  svc.publish(agent, 'assistant/message', { turn: 4, message: { role: 'assistant', content: [{ type: 'text', text: 'The suite passes.' }] } })
  // The recovery turn answers plainly, so the guard queues no second followup and the stop reaches the bound.
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 1, 'the recovery turn speaks the prompt\'s single message, not a second one')
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 1, 'a later stop of the recovery turn must stay silent')
  assert.equal(agent.followups.length, 1, 'the recovery turn must not queue a second followup')
  // A real user message is what re-arms, so the next prompt speaks once more.
  begin(svc, agent, 5)
  prompt(svc, agent, 5)
  announce(svc, agent, { turn: 5, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 5)
  assert.equal(agent.steers.length, 2, 'the next real prompt must re-arm exactly one message')
})

test('a notice recorded after the prompt message waits for the next real prompt', async () => {
  const a = changedRepo('notice-wait-a')
  const b = changedRepo('notice-wait-b')
  const svc = service()
  const agent = agentFor(a)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: a, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1)
  assert.ok(steerText(agent.steers[0]).includes(INTRO), 'precondition: the first message introduces the first repository')
  announce(svc, agent, { turn: 3, cwd: a, files: ['app.js', path.join(b, 'app.js')] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'a repository seen after the message must wait for the next prompt')
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: a, files: ['app.js', path.join(b, 'app.js')] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the next real prompt carries the waiting notice')
  const second = steerText(agent.steers[1])
  assert.ok(second.includes(INTRO), 'the second message must introduce the repository that waited')
  assert.ok(second.includes(`Root: ${b}`), 'the second message must name the waiting repository')
})

test('a credential hit recorded after the prompt message waits for the next real prompt', async () => {
  const repo = changedRepo('credential-wait')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [[]] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first stop sends the prompt advisory')
  assert.doesNotMatch(steerText(agent.steers[0]), /Possible hard-coded credential/, 'the first message has no hit to name')
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [['+password = "hunter2hunter2"']] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'a hit recorded after the message must ride the next prompt, not a second message')
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'], diffs: [['+password = "hunter2hunter2"']] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the next prompt carries the hit')
  const text = steerText(agent.steers[1])
  assert.match(text, /Possible hard-coded credential or secret/, 'the next message must name the rule')
  assert.doesNotMatch(text, /hunter2/, 'the matched value must never be written into the message')
})

// A hit the bound suppressed is kept, not lost: the change record is turn-scoped, so the next prompt's own diff cannot
// show it again. The hit rides the next prompt's one message even when that prompt changes nothing that trips the scan.
test('a credential hit suppressed by the bound is carried into the next prompt even when its own diff is clean', async () => {
  const repo = changedRepo('credential-carried')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [[]] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first stop sends the prompt advisory')
  assert.doesNotMatch(steerText(agent.steers[0]), /Possible hard-coded credential/, 'precondition: the first message has no hit to name')
  // The same prompt stops again, and now the read succeeds and exposes the credential. The bound suppresses the message.
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [['+password = "hunter2hunter2"']] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'the second stop of one prompt must stay silent')
  // The next prompt changes nothing that trips the scan, so only a retained hit can name the credential.
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['other.js'], diffs: [[]] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the next prompt must speak once')
  const text = steerText(agent.steers[1])
  assert.match(text, /Possible hard-coded credential or secret/, 'the carried hit must be named even when the new diff is clean')
  assert.doesNotMatch(text, /hunter2/, 'the matched value must never be written into the message')
  // The carried hit is spent: a later prompt must not repeat a credential the session already saw.
  begin(svc, agent, 5)
  prompt(svc, agent, 5)
  announce(svc, agent, { turn: 5, cwd: repo, files: ['other.js'], diffs: [[]] })
  await stop(svc, agent, 5)
  const later = agent.steers.at(-1)
  assert.equal(agent.steers.length, 3, 'precondition: the later prompt speaks about its own unfinished work')
  assert.doesNotMatch(steerText(later), /Possible hard-coded credential/, 'a carried hit must not be repeated once it has been named')
})

test('verificationNudgeLimit is not consulted', async () => {
  const repo = changedRepo('nudge-dead')
  const svc = service({ settings: { verificationNudgeLimit: 0 } })
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'a zero verificationNudgeLimit must not silence the advisory')
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the retired limit must not bound a later prompt either')
})

test('an enabled false setting silences the gate for a real prompt', async () => {
  const repo = changedRepo('disabled-prompt')
  const svc = service({ settings: { enabled: false } })
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 0, 'a disabled gate must not speak')
  begin(svc, agent, 4)
  prompt(svc, agent, 4)
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 0, 'a disabled gate must stay silent across prompts')
})

test('a stop with nothing to say does not spend the prompt message', async () => {
  const repo = changedRepo('nothing-then-something')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  // The turn ended covered and announced no change, so the first stop has nothing to say.
  svc.publish(agent, 'turn/end', { turn: 3 })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 0, 'precondition: an unchanged turn sends nothing')
  const b = changedRepo('nothing-then-something-b')
  announce(svc, agent, { turn: 3, cwd: repo, files: [path.join(b, 'app.js')] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'the first stop with something to say must carry the prompt message')
})

// A stop the host dispatched before any real user message armed the bound owes the one message later, so the first
// prompt of the session is not swallowed as if the unarmed stop had spent it.
test('a stop that arrives before any real user prompt does not spend the first prompt message', async () => {
  const repo = changedRepo('unarmed')
  const svc = service()
  const agent = agentFor(repo)
  svc.publish(agent, 'turn/start', { turn: 1 })
  announce(svc, agent, { turn: 1, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 1)
  assert.equal(agent.steers.length, 0, 'precondition: no prompt has armed the bound, so the first stop speaks nothing')
  prompt(svc, agent, 1)
  announce(svc, agent, { turn: 1, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 1)
  assert.equal(agent.steers.length, 1, 'the first real prompt must still get its one message')
})

// The bound is one message per prompt, so a second real user message reaches the gate as a second prompt of the same
// turn and must be able to speak, even though the turn number did not change.
test('a second real user message in the same turn re-arms the bound', async () => {
  const repo = changedRepo('same-turn')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  prompt(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first prompt speaks')
  svc.publish(agent, 'user/message', userMessage(agent.id, 3))
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 2, 'a second real prompt in the same turn must arm its own message')
})

// Two silent stops of one prompt rescan the same turn record. The kept hit must name the credential once, not once
// per stop, and the next prompt's own clean diff adds nothing.
test('two silent stops keep one copy of the same credential hit', async () => {
  const repo = changedRepo('credential-dedup')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  // The prompt's own stop reports unclaimed work, so it spends the one message before any hit exists.
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [[]] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the prompt spent its message')
  assert.doesNotMatch(steerText(agent.steers[0]), /Possible hard-coded credential/, 'precondition: the first message has no hit to name')
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [['+password = "hunter2hunter2"']] })
  await stop(svc, agent, 3)
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'both stops of the prompt must stay silent')
  begin(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['other.js'], diffs: [[]] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the next prompt speaks once')
  // The message counts hits by rule, so one kept hit reads as one line, not as two.
  const text = steerText(agent.steers[1])
  assert.match(text, /- Possible hard-coded credential or secret: 1 line$/m, `the carried hit must be counted once: ${text}`)
})

// A file whose added lines could not be read at a silent stop is a notice the next prompt's clean diff cannot show,
// so it rides the next prompt's message the same way a kept credential hit does.
test('a silent stop carries an unread-file notice the next prompt cannot read again', async () => {
  const repo = changedRepo('gap-carried')
  writeCatalog(repo, ['unit'])
  // Every read fails until the next prompt opens, so the unread file exists only in what the gate kept. The flips
  // the read off just before the prompt that must carry it.
  const changes = recorder()
  let failing = true
  changes.diff = async () => (failing ? Promise.reject(new Error('transient read failure')) : { kind: 'text', hunks: [{ lines: [] }] })
  const svc = service({ workspaceChanges: changes })
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'precondition: the first stop sent the advisory')
  assert.match(steerText(agent.steers[0]), /1 changed file could not be read for this scan/, 'precondition: the first message already named the unread file')
  assert.equal(agent.steers.length, 1, 'precondition: the prompt spent its message on the unread file')
  // The repository is complete now. The host drops turn 3's saved diffs, so the report re-reads that turn cleanly and
  // the only way the unread file can be named again is the copy the bound kept.
  changes.diffs.clear()
  await svc.attest(agent, { repository_root: repo, claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'], items: [{ id: 'unit', state: 'passed' }] })
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 1, 'a stop over an attested, unchanged set must stay silent')
  failing = false
  begin(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['other.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 2, 'the next prompt speaks once')
  const text = steerText(agent.steers[1])
  assert.match(text, /1 changed file could not be read for this scan/, `the kept unread file must be named at the next prompt: ${text}`)
  assert.match(text, /- app\.js: transient read failure$/m, 'the kept unread file must be named by its path')
})

// The turn's changed lines are readable even when the repository report throws, so a credential in them is named now
// rather than lost with the error notice.
test('a credential is named even when the repository report fails', async () => {
  const repo = changedRepo('credential-report-failure')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'], diffs: [['+password = "hunter2hunter2"']] })
  const report = svc.repositoryReport
  svc.repositoryReport = async () => { throw new Error('report failure') }
  try { await stop(svc, agent, 3) } finally { svc.repositoryReport = report }
  assert.equal(agent.steers.length, 1, 'an evaluation failure still sends its one message')
  const text = steerText(agent.steers[0])
  assert.match(text, /could not evaluate the workspace/, 'the failure is still named')
  assert.match(text, /Possible hard-coded credential or secret/, 'the readable changed lines must still be scanned')
})
