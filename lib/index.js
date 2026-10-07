import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ChangeTracker, changeDigest, isDocumentationOnly, readTurnChanges } from './changes.js'
import { cleanText, evaluateAttestation, normalizeAttestation, reportMarkdown, resolveConfig } from './core.js'
import { VerificationLedger, ledgerRow } from './ledger.js'
import { loadManifest, resolveRecipe, saveManifest } from './recipe.js'
import { runRecipe } from './recipe-runner.js'
import { addedLinesForRecord, projectRoot, runMachineGate } from './runner.js'
import { defaultSettingsPath, editableConfig, mergeSettings, readSavedSettings, removeSavedSettings, sanitizeSettingsPatch, settingsSummary, writeSavedSettings } from './settings.js'
import { runTemporaryScript, validateTemporaryScript, verificationGuidance, verificationInventory } from './verification.js'

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
    this.changes = new ChangeTracker()
    this.ledger = new VerificationLedger()
    this.rootCache = new Map()
    this.cwdBySession = new Map()
    this.disposers = []
  }

  state(agent) {
    const id = sessionKey(agent)
    if (!this.states.has(id)) this.states.set(id, {
      cached: new Map(), attestation: null, override: null,
      lastReport: null, lastPass: '', autoBlocks: 0, continuationTurn: 0, continuationBlocks: 0, recoveryPending: false, nudge: null,
    })
    return this.states.get(id)
  }

  applies(agent) { return this.config.gateSubagents || !isSubagent(agent) }

  invalidateEvidence() {
    // Changing gate policy discards recorded verification: a pass earned under different
    // rules must not be reused.
    this.ledger.clearAll()
    for (const state of this.states.values()) {
      state.cached.clear()
      state.attestation = null
      state.override = null
      state.lastReport = null
      state.autoBlocks = 0
      state.continuationTurn = 0
      state.continuationBlocks = 0
      state.recoveryPending = false
      state.nudge = null
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

  // The host change recorder is read without an inject requirement: listing it in `inject`
  // would make it a required dependency and unload this plugin wherever the recorder is not
  // mounted. `ctx.reflect.get` returns undefined instead, which the gate reports as
  // "changes cannot be determined" rather than treating the workspace as unchanged.
  changeService() {
    try { return this.ctx?.reflect?.get?.('workspaceChanges') ?? null } catch { return null }
  }

  async root(agent) {
    const dir = sessionCwd(agent)
    if (!dir) throw new Error('Completion Gate requires session.header.cwd')
    // Remembered so the operator panel can report the selected verification source for the last
    // session the gate evaluated, which has no agent of its own.
    this.cwdBySession.set(sessionKey(agent), dir)
    if (!this.rootCache.has(dir)) this.rootCache.set(dir, await projectRoot(dir))
    return this.rootCache.get(dir)
  }

  // The latest turn this session opened. The tracker advances it from `turn/start`, so a tool
  // call inside a turn resolves that same turn, and the stop handler passes its own turn.
  currentTurn(agent) { return this.changes.lastTurn(sessionKey(agent)) }

  // Resolve what this turn changed, from the host's turn-scoped record. `determined: false`
  // means the source could not be trusted, and the gate blocks saying so.
  async turnChanges(agent, requestedTurn = null) {
    const turn = Number.isInteger(requestedTurn) ? requestedTurn : this.currentTurn(agent)
    const id = sessionKey(agent)
    const record = readTurnChanges({
      service: this.changeService(), tracker: this.changes, sessionId: id, turn,
      // The recorder never covers a subagent session, so for one of those a missing announcement
      // means the source is blind rather than that the turn changed nothing.
      recorded: !isSubagent(agent),
    })
    const root = await this.root(agent)
    // The operator's cap bounds what the gate will handle, but it must not silently exempt the
    // files beyond it from review: a truncated inventory means the complete changed set is
    // unknown, which is reported rather than treated as an unchanged or fully reviewed turn.
    const capped = record.files.length > this.config.maxChangedFiles
    const files = record.files.slice(0, this.config.maxChangedFiles)
    const determined = record.determined && !capped
    const documentationOnly = isDocumentationOnly(files)
    const service = this.changeService()
    let addedLines = [], diffGaps = []
    if (determined && record.seq !== null && files.length && service?.diff) {
      const collected = await addedLinesForRecord(service, id, record.seq, files.length, new AbortController().signal)
      addedLines = collected.lines
      diffGaps = collected.gaps
    }
    const workspace = {
      root, label: root.split(/[\\/]/).pop() || 'workspace', turn, sessionId: id,
      seq: record.seq, determined, documentationOnly, addedLines, diffGaps,
      reason: capped
        ? `This turn changed ${record.files.length} files, over the configured limit of ${this.config.maxChangedFiles}, so the complete set of changed files cannot be determined.`
        : record.reason,
      files,
      fingerprint: changeDigest(id, turn, record.seq, files),
    }
    return workspace
  }

  changed(workspace) { return workspace.files.length > 0 }

  decorate(machine, state, workspace) {
    const attestation = this.config.requireAttestation
      ? evaluateAttestation(state.attestation, workspace.files, workspace.fingerprint)
      : { pass: true, problems: [] }
    // A passing verification covers the missing-harness condition only. Hard failures, the
    // added-line scans, the changed-file review and the attestation are never covered by it.
    const verified = machine.documentationOnly
      || this.ledger.satisfied(workspace.sessionId, workspace.fingerprint)
    const covered = Boolean(machine.missingTestCommand) && verified
    const blockers = [
      ...machine.hardBlockers,
      ...(machine.missingTestCommand && !covered ? [machine.missingTestCommand] : []),
      ...(!attestation.pass ? attestation.problems : []),
    ]
    const overridden = Boolean(state.override && state.override.fingerprint === workspace.fingerprint)
    return {
      ...machine, pass: overridden || blockers.length === 0, blockers, attestation, overridden,
      verificationCoveredMissingHarness: covered, generatedAt: Date.now(),
    }
  }

  async run(agent, signal, { force = false, turn = null } = {}) {
    const state = this.state(agent)
    const workspace = await this.turnChanges(agent, turn ?? this.currentTurn(agent))
    if (!force && this.config.gateOnlyChangedWorkspaces && workspace.determined && !this.changed(workspace)) {
      const report = {
        workspaceLabel: workspace.label, fingerprint: workspace.fingerprint, pass: true, machinePass: true,
        skipped: true, changedFiles: [], turn: workspace.turn, changesDetermined: true,
        checks: [], todoHits: [], securityHits: [], blockers: [],
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

  // The single verification decision. The stop hook, the runner and the tool handler all read
  // this, so they cannot disagree about which source applies.
  async inventory(agent, workspace = null) {
    const current = workspace ?? await this.turnChanges(agent)
    return verificationInventory({
      cwd: current.root, config: this.config, ledger: this.ledger,
      sessionId: sessionKey(agent), fingerprint: current.fingerprint,
      documentationOnly: current.documentationOnly,
    })
  }

  // Run or inspect a recipe. Never called implicitly: the agent asks for it.
  async recipe(agent, args = {}) {
    const workspace = await this.turnChanges(agent)
    const resolved = resolveRecipe(workspace.root, this.config)
    const inventory = await this.inventory(agent, workspace)
    if (args.save) {
      if (!resolved.recipe) return { ok: false, report: { workspaceLabel: workspace.label, fingerprint: workspace.fingerprint, pass: false, blockers: ['No recipe resolved, so there is nothing to save.'], checks: [], changedFiles: workspace.files, turn: workspace.turn, recordSeq: workspace.seq, changesDetermined: workspace.determined, attestation: { pass: true, problems: [] } } }
      const file = saveManifest(workspace.root, resolved.recipe)
      return { ok: true, saved: file, recipe: resolved.recipe, source: resolved.source, problems: resolved.problems }
    }
    if (args.inspect) {
      return { ok: true, inspect: true, source: resolved.source, recipe: resolved.recipe, problems: resolved.problems, inventory }
    }
    if (!resolved.recipe) {
      return { ok: false, blockers: ['No verification recipe resolved for this project.'], source: resolved.source, problems: resolved.problems }
    }
    const result = await runRecipe(workspace.root, resolved.recipe, this.config, {
      phases: args.phases, skipStart: args.skip_start, portOverride: args.port, signal: new AbortController().signal,
    })
    this.recordVerification(agent, workspace, {
      source: 'recipe', name: resolved.recipe.name, kind: resolved.recipe.kind,
      scope: result.scope, pass: result.pass,
      output: (result.phases || []).map(phase => `${phase.phase}: ${phase.ok ? 'ok' : 'FAIL'}${phase.timedOut ? ' (timed out)' : ''}\n${phase.output}`).join('\n'),
      detail: result.reason || result.scopeReason || '',
    })
    const report = await this.run(agent, new AbortController().signal, { force: true })
    return { ok: true, run: result, report }
  }

  // Run a temporary verification script. Last resort only: refused whenever a stronger verifier
  // exists, and refused when a verifier is configured but unavailable.
  async temporaryVerify(agent, args = {}) {
    const workspace = await this.turnChanges(agent)
    const inventory = await this.inventory(agent, workspace)
    if (!inventory.temporary.eligible) {
      return { ok: false, blockers: [`The temporary verifier is not available here: ${inventory.temporary.reason || 'a stronger verifier exists'}.`], inventory }
    }
    const validation = validateTemporaryScript({ scriptPath: args.script_path, cwd: workspace.root, runtime: args.runtime })
    if (!validation.ok) return { ok: false, blockers: [validation.reason], inventory }
    const outcome = await runTemporaryScript(validation, workspace.root, args.arguments, this.config)
    this.recordVerification(agent, workspace, {
      source: 'temporary', name: path.basename(validation.resolved), kind: validation.runtime,
      scope: 'targeted', pass: outcome.pass, output: outcome.output, detail: outcome.detail || '',
    })
    // A passing script is deleted so the tree does not accumulate probes; a failing one is left
    // on disk so the agent can inspect and repair it.
    if (outcome.pass) { try { fs.unlinkSync(validation.resolved) } catch {} }
    const report = await this.run(agent, new AbortController().signal, { force: true })
    return { ok: true, run: outcome, report }
  }

  recordVerification(agent, workspace, evidence) {
    this.ledger.record(sessionKey(agent), ledgerRow({ ...evidence, turn: workspace.turn, seq: workspace.seq, fingerprint: workspace.fingerprint }))
  }

  async attest(agent, args) {
    const state = this.state(agent)
    const workspace = await this.turnChanges(agent)
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
    const workspace = await this.turnChanges(agent)
    state.override = { fingerprint: workspace.fingerprint, reason: cleanText(reason || 'Operator override', 1000), createdAt: Date.now() }
    return this.run(agent, new AbortController().signal)
  }

  reset(agent) {
    const state = this.state(agent)
    state.cached.clear(); state.attestation = null; state.override = null; state.lastReport = null
    state.autoBlocks = 0; state.continuationTurn = 0; state.continuationBlocks = 0; state.recoveryPending = false; state.nudge = null
    // Resetting session evidence discards every recorded verification row, so a pass cannot
    // survive the reset that is meant to clear it.
    this.ledger.clear(sessionKey(agent))
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
    try { report = await this.run(agent, signal, { turn }) }
    catch (error) {
      if (this.config.mode === 'strict') agent.steer({
        id: crypto.randomUUID(), role: 'user',
        content: [{ type: 'text', text: `Completion Gate could not evaluate the workspace: ${cleanText(error?.message || error, 1000)}. Investigate before claiming completion.` }],
        source: SOURCE,
      })
      return
    }
    if (report.pass || this.config.mode === 'advisory') return
    const state = this.state(agent)
    state.autoBlocks += 1
    // Verification nudges are bounded per change record: past the configured bound the gate
    // states the block briefly instead of repeating the long instruction, so it cannot trap an
    // agent in a loop.
    const bound = this.config.verificationNudgeLimit
    // Only the current change record's count is kept, so the bound is per change record and the
    // bookkeeping cannot grow with the session.
    if (state.nudge?.fingerprint !== report.fingerprint) state.nudge = { fingerprint: report.fingerprint, count: 0 }
    state.nudge.count += 1
    const seen = state.nudge.count
    const repeated = bound > 0 && seen > bound
    const guidance = repeated ? null : verificationGuidance(await this.inventory(agent))
    const text = repeated
      ? `COMPLETION GATE STILL BLOCKED (${seen} checks on this change set). Do not claim completion.\n\n${report.blockers.map(x => `- ${x}`).join('\n')}`
      : `COMPLETION GATE BLOCKED. Do not claim completion.\n\n${report.blockers.map(x => `- ${x}`).join('\n')}${guidance ? `\n\n${guidance}` : ''}\n\nFix the failures, review every changed file, then call completion_gate with action=attest and concrete acceptance-criteria evidence.`
    agent.steer({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text }], source: SOURCE })
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
      verification: this.verificationOverview(),
      sessions,
      blocked: sessions.filter(x => !x.pass).length,
      passed: sessions.filter(x => x.pass).length,
    }
  }

  // The control center's view of the chosen verification source and why. It reports the last
  // session the gate evaluated, since the operator panel has no agent of its own.
  verificationOverview() {
    const last = [...this.states.keys()].pop()
    if (!last) return { available: false }
    const cwd = this.cwdBySession?.get(last)
    if (!cwd) return { available: false }
    try {
      const inventory = verificationInventory({ cwd, config: this.config, ledger: this.ledger, sessionId: last, fingerprint: '' })
      const saved = loadManifest(cwd)
      return {
        available: true,
        sessionId: last,
        selected: inventory.selected,
        canonical: { exists: inventory.canonical.exists, checks: inventory.canonical.checks.map(check => `${check.category}: ${check.name}`) },
        external: inventory.external,
        savedRecipe: saved.recipe ? { name: saved.recipe.name, kind: saved.recipe.kind } : null,
        recipe: { source: inventory.recipe.source, usable: inventory.recipe.usable, name: inventory.recipe.recipe?.name ?? null, kind: inventory.recipe.recipe?.kind ?? null, problems: inventory.recipe.problems },
        temporary: inventory.temporary,
      }
    } catch (error) { return { available: false, error: cleanText(error?.message || error, 300) } }
  }

  registerTool() {
    return this.ctx.tools.register({
      name: 'completion_gate',
      description: 'Run, inspect, attest, or verify the production-readiness completion gate.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['run', 'status', 'attest', 'recipe', 'temporary_verify'] },
          reviewed_files: { type: 'array', items: { type: 'string' } },
          review_summary: { type: 'string' },
          acceptance_criteria: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { criterion: { type: 'string' }, evidence: { type: 'string' } }, required: ['criterion', 'evidence'] } },
          unresolved_issues: { type: 'array', items: { type: 'string' } },
          inspect: { type: 'boolean' },
          save: { type: 'boolean' },
          phases: { type: 'array', items: { type: 'string', enum: ['bootstrap', 'build', 'test', 'start'] } },
          skip_start: { type: 'boolean' },
          port: { type: 'number' },
          script_path: { type: 'string' },
          runtime: { type: 'string', enum: ['node', 'python3', 'python', 'bash', 'sh', 'ruby', 'perl'] },
          arguments: { type: 'array', items: { type: 'string' } },
        }, required: ['action'],
      },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: value.markdown }] },
      execute: async (args, exec) => {
        // The recipe and temporary-verifier actions are never implicit: only an explicit action
        // reaches them, so the stop hook can never start a recipe or a probe by itself.
        if (args.action === 'recipe') {
          const outcome = await this.recipe(exec.agent, args)
          if (outcome.inspect) {
            return { pass: null, inspect: true, markdown: `# Completion Gate recipe\n\nSource: \`${outcome.source}\`\n\n\`\`\`json\n${JSON.stringify(outcome.recipe, null, 2)}\n\`\`\`${outcome.problems.length ? `\n\nProblems:\n${outcome.problems.map(p => `- ${p}`).join('\n')}` : ''}` }
          }
          if (outcome.saved) return { pass: null, saved: outcome.saved, markdown: `# Completion Gate recipe saved\n\nWritten to \`${outcome.saved}\` (source: ${outcome.source}).` }
          if (!outcome.ok) return { pass: false, blockers: outcome.blockers || [], markdown: `# Completion Gate recipe\n\nNo recipe was run.\n\n${(outcome.blockers || []).map(x => `- ${x}`).join('\n')}${outcome.problems?.length ? `\n\n${outcome.problems.map(p => `- ${p}`).join('\n')}` : ''}` }
          return { pass: outcome.report.pass, fingerprint: outcome.report.fingerprint, blockers: outcome.report.blockers, markdown: reportMarkdown(outcome.report) }
        }
        if (args.action === 'temporary_verify') {
          const outcome = await this.temporaryVerify(exec.agent, args)
          if (!outcome.ok) return { pass: false, blockers: outcome.blockers || [], markdown: `# Completion Gate temporary verifier\n\nNot run.\n\n${(outcome.blockers || []).map(x => `- ${x}`).join('\n')}` }
          return { pass: outcome.report.pass, fingerprint: outcome.report.fingerprint, blockers: outcome.report.blockers, markdown: reportMarkdown(outcome.report) }
        }
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
    // The changed-file source is the host recorder's own `workspace/changes` event, so track
    // the sequence it announces per turn and forget a session's record when it is disposed.
    this.disposers.push(this.ctx.on('session/event', (session, event) => { this.changes.observe(session, event) }))
    this.disposers.push(this.ctx.on('session/disposed', session => { this.changes.forget(String(session?.id ?? '')) }))
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
