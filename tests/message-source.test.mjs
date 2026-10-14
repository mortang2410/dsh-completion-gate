import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CompletionGateService } from '../lib/index.js'

// The host refuses any durable message whose source.kind is the bare string 'plugin'
// ("format v4 message requires a producer-owned source kind", session-format-v3-to-v4
// message-sources.ts). A message the gate steers or follows up with carries the source
// below, so this file pins the exact kind the gate emits and nothing weaker.

const PRODUCER_KIND = 'plugin:dsh-completion-gate'
const REFUSED_KIND = 'plugin'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tempRepo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-source-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  git(dir, ['init', '-q', '.'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(dir, 'app.js'), 'const value = 1\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'init'])
  return dir
}

function recorder(entries = new Map()) {
  return {
    entries,
    summary(sessionId, seq) { return entries.get(`${sessionId}:${seq}`) },
    async diff() { return undefined },
  }
}

// A stub host whose session/event hook is the only way turn events reach the gate.
function service({ workspaceChanges = recorder(), settings = {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-source-settings-')))
  const listeners = new Map()
  const off = () => () => {}
  const ctx = {
    reflect: { get: name => (name === 'workspaceChanges' ? workspaceChanges : undefined) },
    on: (name, listener) => { listeners.set(name, listener); return off() },
    provide: off, tools: { register: off }, commands: { register: off }, systemPrompt: { section: off }, webServer: { register: off },
  }
  const instance = new CompletionGateService(ctx, settings, { settingsPath: path.join(dir, 'settings.json') })
  instance.__testSettingsDir = dir
  instance.start()
  let published = 0
  instance.publish = (agent, type, data) => listeners.get('session/event')({ id: agent.id }, { type, seq: ++published, time: Date.now(), data })
  return instance
}

function agentFor(cwd, id = 'session-1') {
  const steers = [], followups = []
  return { id, session: { header: { cwd }, events: [] }, steer: m => steers.push(m), followup: m => followups.push(m), steers, followups }
}

function announce(svc, sessionId, turn, seq, files) {
  svc.changes.observe({ id: sessionId }, { type: 'turn/start', data: { turn } })
  svc.changes.observe({ id: sessionId }, { type: 'workspace/changes', seq, data: { turn } })
  svc.changeService().entries.set(`${sessionId}:${seq}`, {
    turn, cwd: '/repo', files, total: files.length, added: files.length, deleted: 0,
  })
}

function assertProducerOwned(message, where) {
  assert.ok(message, `${where}: no message was emitted`)
  assert.equal(typeof message.source, 'object', `${where}: the message carries no source object`)
  assert.notEqual(message.source.kind, REFUSED_KIND, `${where}: the bare 'plugin' kind is refused by the host`)
  assert.equal(message.source.kind, PRODUCER_KIND, `${where}: expected the producer-owned kind ${PRODUCER_KIND}`)
}

test('the premature-stop follow-up carries the producer-owned source kind', async t => {
  const svc = service({ settings: { autoDetectChecks: false, requireTests: false } })
  try {
    const agent = agentFor(tempRepo(t))
    svc.publish(agent, 'turn/start', { turn: 11 })
    svc.publish(agent, 'assistant/message', { turn: 11, message: { content: [{ type: 'text', text: 'Now I need the call site to see where each value comes from.' }] } })
    svc.publish(agent, 'tool/call', { turn: 11, name: 'grep' })
    svc.publish(agent, 'tool/result', { turn: 11 })
    svc.publish(agent, 'assistant/message', { turn: 11, message: { content: [{ type: 'reasoning', text: 'HUGE finding.' }] } })
    await svc.stopping({ agent, turn: 11, signal: new AbortController().signal })
    assert.equal(agent.followups.length, 1, 'the unfinished turn must produce exactly one follow-up')
    assertProducerOwned(agent.followups[0], 'agent.followup')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('the blocked-stop steer carries the producer-owned source kind', async t => {
  const repo = tempRepo(t)
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0' }) + '\n')
  fs.writeFileSync(path.join(repo, 'app.js'), 'const value = 2\n')
  const svc = service()
  try {
    const agent = agentFor(repo)
    announce(svc, 'session-1', 3, 305, [{ path: 'app.js', display: 'app.js', added: 1, deleted: 0 }])
    await svc.stopping({ agent, turn: 3, signal: new AbortController().signal })
    assert.equal(agent.steers.length, 1, 'an unattested change set must produce exactly one steer')
    assertProducerOwned(agent.steers[0], 'agent.steer')
  } finally { fs.rmSync(svc.__testSettingsDir, { recursive: true, force: true }) }
})

test('every message emitter in lib/index.js uses the one producer-owned source', () => {
  const file = fileURLToPath(new URL('../lib/index.js', import.meta.url))
  const text = fs.readFileSync(file, 'utf8')
  const declared = /const SOURCE = Object\.freeze\(\{ kind: '([^']+)'/.exec(text)
  assert.ok(declared, 'lib/index.js declares no frozen SOURCE constant')
  assert.equal(declared[1], PRODUCER_KIND, `SOURCE declares the kind ${declared[1]}, which the host refuses or does not expect`)
  const uses = [...text.matchAll(/source: SOURCE/g)]
  assert.equal(uses.length, 3, `expected the three message emitters to pass SOURCE, found ${uses.length}`)
  assert.doesNotMatch(text, /kind: ['"]plugin['"]/, "lib/index.js still builds the refused bare 'plugin' kind")
})
