import crypto from 'node:crypto'
import { cleanText, evaluateAttestation, normalizeAttestation, reportMarkdown, resolveConfig } from './core.js'
import { inspectWorkspace, runMachineGate } from './runner.js'
import { defaultSettingsPath, editableConfig, mergeSettings, readSavedSettings, removeSavedSettings, sanitizeSettingsPatch, settingsSummary, writeSavedSettings } from './settings.js'

const API_PREFIX = '/api/completion-gate/v1'
const SOURCE = Object.freeze({ kind: 'plugin', plugin: 'dsh-completion-gate' })

export const name = 'completion-gate'
export const inject = ['tools', 'commands', 'webServer', 'systemPrompt']

function sessionKey(agent) { return String(agent?.id || agent?.session?.header?.id || 'unknown') }
function sessionCwd(agent) { return String(agent?.session?.header?.cwd || '') }
function isSubagent(agent) {
  const header = agent?.session?.header
  return Boolean(header?.parentSession) || Number(header?.delegationDepth || 0) > 0
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

function sameOrigin(req) {
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  const host = req.headers?.host
  if (typeof origin !== 'string') return req.headers?.['sec-fetch-site'] === 'same-origin'
  if (typeof host !== 'string') return false
  try { return new URL(origin).host === host } catch { return false }
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('Request body is too large.')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function messageContent(message) {
  const text = [], reasoning = []
  let toolCalls = 0
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text)
    else if (block?.type === 'reasoning' && typeof block.text === 'string') reasoning.push(block.text)
    else if (block?.type === 'tool-call') toolCalls += 1
  }
  return { text: text.join('\n').trim(), reasoning: reasoning.join('\n').trim(), toolCalls }
}

const FUTURE_INTENT = [
  /\bnow\s+i\s+need\b/i,
  /\bnext\s+i(?:'ll|\s+will|\s+need\s+to)\b/i,
  /\bi\s+(?:still\s+)?need\s+to\b/i,
  /\blet\s+me\s+(?:check|inspect|trace|verify|test|run|search|read|look|implement|fix|continue|start|compare|review|open)\b/i,
  /\bi(?:'ll|\s+will)\s+(?:now\s+)?(?:check|inspect|trace|verify|test|run|search|read|look|implement|fix|continue|start|compare|review|open)\b/i,
  /\bin\s+parallel\b/i,
  /\bnext\s+step\b/i,
  /\bneed\s+to\s+(?:see|check|inspect|trace|verify|test|run|search|read|implement|fix)\b/i,
]

export function turnEvidence(agent, turn) {
  const events = Array.isArray(agent?.session?.events) ? agent.session.events : []
  const current = events.filter(event => event?.data?.turn === turn)
  const assistant = current.filter(event => event.type === 'assistant/message')
  const toolCalls = current.filter(event => event.type === 'tool/call')
  const toolResults = current.filter(event => event.type === 'tool/result')
  const content = messageContent(assistant.at(-1)?.data?.message)
  const combined = `${content.text}\n${content.reasoning}`
  return {
    assistantMessages: assistant.length,
    toolCalls: toolCalls.length,
    toolResults: toolResults.length,
    text: content.text,
    reasoning: content.reasoning,
    futureIntent: FUTURE_INTENT.some(pattern => pattern.test(combined)),
    reasoningOnlyAfterTools: toolCalls.length > 0 && Boolean(content.reasoning) && !content.text && content.toolCalls === 0,
  }
}

function publicSessionState(id, state) {
  if (!state.lastReport) return null
  return {
    sessionId: id,
    pass: state.lastReport.pass,
    workspaceLabel: state.lastReport.workspaceLabel,
    autoBlocks: state.autoBlocks,
    continuationBlocks: state.continuationBlocks,
    override: Boolean(state.override),
    checks: (state.lastReport.checks || []).map(check => ({
      name: check.name, category: check.category, pass: check.pass, required: check.required, durationMs: check.durationMs,
    })),
    blockers: state.lastReport.blockers || [],
  }
}

export class CompletionGateService {
  constructor(ctx, profileConfig = {}, deps = {}) {
    this.ctx = ctx
    this.profileConfig = resolveConfig(profileConfig)
    this.settingsPath = deps.settingsPath || defaultSettingsPath()
    const saved = readSavedSettings(this.settingsPath)
    this.config = mergeSettings(this.profileConfig, saved)
    this.hasSavedSettings = Boolean(saved)
    this.states = new Map()
    this.disposers = []
  }

  state(agent) {
    const id = sessionKey(agent)
    if (!this.states.has(id)) this.states.set(id, {
      baselineHead: '', baselineCaptured: false, cached: new Map(), attestation: null, override: null,
      lastReport: null, lastPass: '', autoBlocks: 0, continuationTurn: 0, continuationBlocks: 0, recoveryPending: false,
    })
    return this.states.get(id)
  }

  applies(agent) { return this.config.gateSubagents || !isSubagent(agent) }

  invalidateEvidence() {
    for (const state of this.states.values()) {
      state.cached.clear()
      state.attestation = null
      state.override = null
      state.lastReport = null
      state.autoBlocks = 0
      state.continuationTurn = 0
      state.continuationBlocks = 0
      state.recoveryPending = false
    }
  }

  updateSettings(patch) {
    const cleanPatch = sanitizeSettingsPatch(patch)
    const next = resolveConfig({ ...editableConfig(this.config), ...cleanPatch })
    writeSavedSettings(this.settingsPath, next)
    this.config = next
    this.hasSavedSettings = true
    this.invalidateEvidence()
    return settingsSummary(this.config)
  }

  resetSettings() {
    removeSavedSettings(this.settingsPath)
    this.config = resolveConfig(this.profileConfig)
    this.hasSavedSettings = false
    this.invalidateEvidence()
    return settingsSummary(this.config)
  }

  async baseline(agent) {
    if (!this.applies(agent)) return
    const state = this.state(agent)
    if (state.baselineCaptured) return
    const dir = sessionCwd(agent)
    if (!dir) { state.baselineCaptured = true; return }
    try { state.baselineHead = (await inspectWorkspace(dir, this.config)).head || '' }
    finally { state.baselineCaptured = true }
  }

  async workspace(agent) {
    const dir = sessionCwd(agent)
    if (!dir) throw new Error('Completion Gate requires session.header.cwd')
    return inspectWorkspace(dir, this.config, this.state(agent).baselineHead)
  }

  changed(workspace, state) {
    return workspace.changedFiles.length > 0 || Boolean(state.baselineHead && workspace.head && state.baselineHead !== workspace.head)
  }

  decorate(machine, state, workspace) {
    const attestation = this.config.requireAttestation
      ? evaluateAttestation(state.attestation, workspace.changedFiles, workspace.fingerprint)
      : { pass: true, problems: [] }
    const blockers = [...machine.blockers, ...(!attestation.pass ? attestation.problems : [])]
    const overridden = Boolean(state.override && state.override.fingerprint === workspace.fingerprint)
    return { ...machine, pass: overridden || blockers.length === 0, blockers, attestation, overridden, generatedAt: Date.now() }
  }

  async run(agent, signal, { force = false } = {}) {
    const state = this.state(agent)
    await this.baseline(agent)
    const workspace = await this.workspace(agent)
    if (!force && this.config.gateOnlyChangedWorkspaces && !this.changed(workspace, state)) {
      const report = {
        workspaceLabel: workspace.root.split(/[\\/]/).pop(), fingerprint: workspace.fingerprint, pass: true, machinePass: true,
        skipped: true, changedFiles: workspace.changedFiles, checks: [], todoHits: [], securityHits: [], blockers: [],
        attestation: { pass: true, problems: [] }, generatedAt: Date.now(),
      }
      state.lastReport = report
      return report
    }
    let machine = state.cached.get(workspace.fingerprint)
    if (!machine || force) {
      machine = await runMachineGate(workspace, this.config, signal)
      state.cached.set(workspace.fingerprint, machine)
    }
    const report = this.decorate(machine, state, workspace)
    state.lastReport = report
    return report
  }

  async attest(agent, args) {
    const state = this.state(agent)
    const workspace = await this.workspace(agent)
    state.attestation = normalizeAttestation(args, workspace.fingerprint)
    let machine = state.cached.get(workspace.fingerprint)
    if (!machine) {
      machine = await runMachineGate(workspace, this.config, new AbortController().signal)
      state.cached.set(workspace.fingerprint, machine)
    }
    const report = this.decorate(machine, state, workspace)
    state.lastReport = report
    return report
  }

  async override(agent, reason) {
    const state = this.state(agent)
    const workspace = await this.workspace(agent)
    state.override = { fingerprint: workspace.fingerprint, reason: cleanText(reason || 'Operator override', 1000), createdAt: Date.now() }
    return this.run(agent, new AbortController().signal)
  }

  reset(agent) {
    const state = this.state(agent)
    state.cached.clear(); state.attestation = null; state.override = null; state.lastReport = null
    state.autoBlocks = 0; state.continuationTurn = 0; state.continuationBlocks = 0; state.recoveryPending = false
  }

  premature(agent, turn) {
    if (!this.config.preventPrematureStops) return null
    const state = this.state(agent)
    const evidence = turnEvidence(agent, turn)
    const emptyRecovery = state.recoveryPending && evidence.assistantMessages > 0 && !evidence.text && !evidence.reasoning && evidence.toolCalls === 0
    const unfinished = evidence.futureIntent || evidence.reasoningOnlyAfterTools || emptyRecovery
    if (!unfinished) {
      state.continuationBlocks = 0
      state.recoveryPending = false
      state.continuationTurn = turn
      return null
    }
    if (state.continuationBlocks >= this.config.prematureStopMaxContinuations) {
      state.recoveryPending = false
      return null
    }
    state.continuationTurn = turn
    state.continuationBlocks += 1
    state.recoveryPending = true
    return { ...evidence, emptyRecovery }
  }

  followupContinue(agent, evidence) {
    const why = evidence.emptyRecovery
      ? 'The previous recovery turn returned no useful assistant content.'
      : evidence.reasoningOnlyAfterTools
        ? 'The latest step ended with reasoning after tool work but no user-facing completion.'
        : 'The latest response explicitly described pending next actions.'
    agent.followup({
      id: crypto.randomUUID(), role: 'user',
      content: [{ type: 'text', text: `PREMATURE STOP RECOVERY: Continue the unfinished task. ${why} Execute the pending investigation or implementation now. Do not summarize or claim completion yet.` }],
      source: SOURCE,
    })
  }

  async stopping({ agent, turn, signal }) {
    if (!this.config.enabled || !this.applies(agent)) return
    const premature = this.premature(agent, turn)
    if (premature) { this.followupContinue(agent, premature); return }
    let report
    try { report = await this.run(agent, signal) }
    catch (error) {
      if (this.config.mode === 'strict') agent.steer({
        id: crypto.randomUUID(), role: 'user',
        content: [{ type: 'text', text: `Completion Gate could not evaluate the workspace: ${cleanText(error?.message || error, 1000)}. Investigate before claiming completion.` }],
        source: SOURCE,
      })
      return
    }
    if (report.pass || this.config.mode === 'advisory') return
    this.state(agent).autoBlocks += 1
    agent.steer({
      id: crypto.randomUUID(), role: 'user',
      content: [{ type: 'text', text: `COMPLETION GATE BLOCKED. Do not claim completion.\n\n${report.blockers.map(x => `- ${x}`).join('\n')}\n\nFix the failures, review every changed file, then call completion_gate with action=attest and concrete acceptance-criteria evidence.` }],
      source: SOURCE,
    })
  }

  snapshot() {
    const sessions = []
    for (const [id, state] of this.states) {
      const row = publicSessionState(id, state)
      if (row) sessions.push(row)
    }
    return {
      enabled: this.config.enabled,
      mode: this.config.mode,
      gateSubagents: this.config.gateSubagents,
      settings: settingsSummary(this.config),
      profileDefaults: settingsSummary(this.profileConfig),
      hasSavedSettings: this.hasSavedSettings,
      sessions,
      blocked: sessions.filter(x => !x.pass).length,
      passed: sessions.filter(x => x.pass).length,
    }
  }

  registerTool() {
    return this.ctx.tools.register({
      name: 'completion_gate',
      description: 'Run, inspect, or attest the production-readiness completion gate.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['run', 'status', 'attest'] },
          reviewed_files: { type: 'array', items: { type: 'string' } },
          review_summary: { type: 'string' },
          acceptance_criteria: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { criterion: { type: 'string' }, evidence: { type: 'string' } }, required: ['criterion', 'evidence'] } },
          unresolved_issues: { type: 'array', items: { type: 'string' } },
        }, required: ['action'],
      },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: value.markdown }] },
      execute: async (args, exec) => {
        let report
        if (args.action === 'attest') report = await this.attest(exec.agent, args)
        else if (args.action === 'status') report = this.state(exec.agent).lastReport || await this.run(exec.agent, exec.signal)
        else report = await this.run(exec.agent, exec.signal, { force: true })
        return { pass: report.pass, fingerprint: report.fingerprint, blockers: report.blockers, markdown: reportMarkdown(report) }
      },
    })
  }

  registerCommands() {
    const registrations = []
    const register = (definition) => { try { registrations.push(this.ctx.commands.register(definition)) } catch {} }
    register({ name: 'gate', description: 'Run Completion Gate now.', handler: async invocation => {
      if (!invocation.agent) return { kind: 'error', text: 'No active agent.' }
      const report = await this.run(invocation.agent, new AbortController().signal, { force: true })
      return { kind: 'success', text: reportMarkdown(report) }
    } })
    register({ name: 'gate-status', description: 'Show the latest Completion Gate report.', handler: async invocation => {
      if (!invocation.agent) return { kind: 'error', text: 'No active agent.' }
      const report = this.state(invocation.agent).lastReport || await this.run(invocation.agent, new AbortController().signal)
      return { kind: 'success', text: reportMarkdown(report) }
    } })
    register({ name: 'gate-reset', description: 'Discard Completion Gate evidence for this session.', handler: invocation => {
      if (!invocation.agent) return { kind: 'error', text: 'No active agent.' }
      this.reset(invocation.agent)
      return { kind: 'success', text: '# Completion Gate\n\nEvidence reset.' }
    } })
    register({ name: 'gate-override', description: 'Operator override for the exact current workspace fingerprint.', input: { hint: 'reason' }, handler: async invocation => {
      if (!invocation.agent) return { kind: 'error', text: 'No active agent.' }
      const report = await this.override(invocation.agent, invocation.rawInput || 'Operator override')
      return { kind: 'success', text: reportMarkdown(report) }
    } })
    return registrations
  }

  async handleApi(req, res) {
    if (!sameOrigin(req)) return json(res, 403, { ok: false, error: 'forbidden' })
    const url = new URL(req.url || '/', 'http://localhost')
    try {
      if (req.method === 'GET' && url.pathname === `${API_PREFIX}/state`) return json(res, 200, { ok: true, ...this.snapshot() })
      if (req.method === 'POST' && url.pathname === `${API_PREFIX}/settings`) {
        const body = await readJsonBody(req)
        const settings = this.updateSettings(body.settings || body)
        return json(res, 200, { ok: true, settings, ...this.snapshot() })
      }
      if (req.method === 'POST' && url.pathname === `${API_PREFIX}/settings/reset`) {
        const settings = this.resetSettings()
        return json(res, 200, { ok: true, settings, ...this.snapshot() })
      }
      return json(res, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      return json(res, 400, { ok: false, error: cleanText(error?.message || error, 1000) })
    }
  }

  start() {
    try { this.disposers.push(this.ctx.provide('completionGate', { run: (agent, opts) => this.run(agent, new AbortController().signal, opts), snapshot: () => this.snapshot() })) } catch {}
    this.disposers.push(this.registerTool())
    this.disposers.push(...this.registerCommands())
    this.disposers.push(this.ctx.systemPrompt.section({
      name: 'tool:completion-gate', order: 188,
      text: 'For code-changing tasks, Completion Gate is authoritative before claiming completion. Do not voluntarily stop immediately after stating pending work such as “now I need”, “next I will”, or “let me inspect”; execute those actions first. Never end on reasoning-only output after tool use. When genuinely finished, call completion_gate action=attest with all changed files reviewed and acceptance criteria mapped to concrete evidence.',
    }))
    this.disposers.push(this.ctx.on('agent/session-start', ({ agent }) => { void this.baseline(agent) }))
    this.disposers.push(this.ctx.on('agent/request', async (payload, next) => { await this.baseline(payload.agent); return next() }))
    this.disposers.push(this.ctx.on('agent/turn-stopping', payload => this.stopping(payload)))
    this.disposers.push(this.ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: (req, res) => this.handleApi(req, res) }))
  }

  dispose() { for (const disposer of this.disposers.splice(0).reverse()) try { disposer?.() } catch {} }
}

export function apply(ctx, config = {}) {
  const service = new CompletionGateService(ctx, config)
  service.start()
  ctx.effect?.(() => () => service.dispose(), 'completion-gate')
}
