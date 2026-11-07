import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompletionGateService } from '../lib/index.js'

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

function begin(svc, agent, turn = TURN) { svc.publish(agent, 'turn/start', { turn }) }

// Announces one turn's change record the way the host does: the event, then the summary it serves for that sequence.
function announce(svc, agent, { turn = TURN, cwd, files, total = files.length, diffs = null }) {
  const seq = svc.publish(agent, 'workspace/changes', { turn })
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
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  await stop(svc, agent)
  assert.equal(agent.steers.length, 2, 'two stops over an unchanged set must send two steers under the bound')
  const first = steerText(agent.steers[0])
  const second = steerText(agent.steers[1])
  assert.ok(first.includes(INTRO), 'the first message must introduce the repository')
  assert.ok(first.includes(path.join(repo, '.dsh', 'verification.json')), 'the introduction must point at the catalog')
  assert.ok(first.includes('Attestation: missing'), 'a repository never attested must say its attestation is missing')
  assert.ok(!second.includes(INTRO), 'the second message must not repeat the introduction')
  assert.ok(second.includes(`Root: ${repo}`), 'the second message must still name the repository')
})

test('the introduction waits for a message the bound lets through', async () => {
  const repo = changedRepo('intro-wait')
  const svc = service({ settings: { verificationNudgeLimit: 0 } })
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 0, 'precondition: a zero limit sends nothing, so nothing is introduced')
  svc.updateSettings({ verificationNudgeLimit: 3 })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 1, 'the first delivered message must come after the limit is raised')
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

test('three messages for one change set, then silence, and a new change set speaks again', async () => {
  const repo = changedRepo('bound')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  for (let i = 0; i < 4; i += 1) await stop(svc, agent)
  assert.equal(agent.steers.length, 3, 'the default limit of three must cap the messages for one change set')
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 3\n')
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  assert.equal(agent.steers.length, 4, 'a changed file is a new change set, which speaks again')
})

test('a nudge limit of zero means the gate never speaks', async () => {
  const repo = changedRepo('zero')
  const svc = service({ settings: { verificationNudgeLimit: 0 } })
  const agent = agentFor(repo)
  begin(svc, agent)
  announce(svc, agent, { cwd: repo, files: ['app.js'] })
  await stop(svc, agent)
  await stop(svc, agent)
  assert.equal(agent.steers.length, 0, 'a zero limit must send no message at all')
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

test('an unchanged change set stays silent on a later turn once the bound is spent', async () => {
  const repo = changedRepo('bound-turn')
  const svc = service()
  const agent = agentFor(repo)
  begin(svc, agent, 3)
  announce(svc, agent, { turn: 3, cwd: repo, files: ['app.js'] })
  for (let i = 0; i < 3; i += 1) await stop(svc, agent, 3)
  assert.equal(agent.steers.length, 3, 'precondition: the bound of three is spent on turn 3')
  begin(svc, agent, 4)
  announce(svc, agent, { turn: 4, cwd: repo, files: ['app.js'] })
  await stop(svc, agent, 4)
  assert.equal(agent.steers.length, 3, 'the same files with the same bytes on a later turn must stay silent')
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
  assert.match(text, /1 changed file could not be read for this scan/, 'the gap line must name the unread file')
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
