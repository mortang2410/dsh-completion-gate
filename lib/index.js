import crypto from 'node:crypto'
import path from 'node:path'
import { readCatalog, registerItems } from './catalog.js'
import { ChangeTracker, changeDigest, contentKey, readTurnChanges } from './changes.js'
import { addedLinesForRecord, cleanText, resolveConfig, scanSecurity } from './core.js'
import { advisoryMessage, registerMarkdown, repositoriesMarkdown } from './report.js'
import { gitRootOf, owningRoot } from './repositories.js'
import { defaultSettingsPath, editableConfig, mergeSettings, readSavedSettings, removeSavedSettings, sanitizeSettingsPatch, settingsSummary, writeSavedSettings } from './settings.js'
import { AttestRefusal, ITEM_STATES, RepositoryTracker, attestSchemaErrors, evaluateRepository, planAttest } from './tracker.js'

const API_PREFIX = '/api/completion-gate/v1'
// The host admits a durable message source whose kind is a non-empty string other than the
// bare 'plugin' (session-format-v3-to-v4 message-sources.ts). The bare kind is the retired V3
// wrapper; the producer-owned form names this package, and no reader here needs the old field.
const SOURCE = Object.freeze({ kind: 'plugin:dsh-completion-gate' })

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

// Phrases that show the model's own pending work: "I need to", "I will" or "I'll" before a work verb, "let me"
// before a work verb, "in parallel" before a work verb, and "need to" with no subject (at a sentence start, at a
// bullet, or after and, but, or still). Advice to the user is not pending work: "you need to", "we need to", and
// a next-step line ("Next step: run the build again.", "Next step: we will publish after review.").
const FUTURE_INTENT = [
  /\bnow\s+i\s+need\b/i,
  /\bnext\s+i(?:'ll|\s+will|\s+need\s+to)\b/i,
  /\bi\s+(?:still\s+)?need\s+to\b/i,
  /\blet\s+me\s+(?:check|inspect|trace|verify|test|run|search|read|look|implement|fix|continue|start|compare|review|open)\b/i,
  /\bi(?:'ll|\s+will)\s+(?:now\s+)?(?:check|inspect|trace|verify|test|run|search|read|look|implement|fix|continue|start|compare|review|open)\b/i,
  /\bin\s+parallel\s+(?:start|begin|launch|kick|spawn|run|check|inspect|trace|verify|search|read|look|implement|fix|continue|compare|open)\b/i,
  /(?:^|[.!?;:\n]\s*|[-*]\s+|,\s*|\b(?:and|but|or)\s+)(?:(?:still|also|now)\s+)*need\s+to\s+(?:see|check|inspect|trace|verify|test|run|search|read|implement|fix)\b/i,
]

// The turn events the gate reads, fed from the session/event hook. A turn runs from its turn/start to its turn/end, and
// events after its turn/end are not kept. The host does not publish a session's seed events to the hook, so a turn that
// began before the gate started has no turn/start here (ACCEPT-H4). Only the most recent turns of a session are kept.
const TURN_EVENT_TYPES = new Set(['turn/start', 'turn/end', 'tool/call', 'tool/result', 'assistant/message'])
const TURNS_KEPT = 20

class TurnEvents {
  constructor() { this.sessions = new Map() }

  observe(session, event) {
    const id = String(session?.id ?? '')
    if (!id || !TURN_EVENT_TYPES.has(event?.type)) return
    const turn = Number(event?.data?.turn)
    if (!Number.isInteger(turn)) return
    let turns = this.sessions.get(id)
    if (!turns) this.sessions.set(id, turns = new Map())
    let record = turns.get(turn)
    if (!record) {
      turns.set(turn, record = { started: false, ended: false, events: [] })
      if (turns.size > TURNS_KEPT) turns.delete(turns.keys().next().value)
    }
    if (record.ended) return
    record.events.push(event)
    if (event.type === 'turn/start') record.started = true
    if (event.type === 'turn/end') record.ended = true
  }

  // The events of one turn, in order. Empty when the hook saw none of them.
  events(sessionId, turn) { return this.sessions.get(String(sessionId ?? ''))?.get(Number(turn))?.events ?? [] }

  forget(sessionId) { this.sessions.delete(String(sessionId ?? '')) }
}

export function turnEvidence(turnEvents) {
  const current = Array.isArray(turnEvents) ? turnEvents : []
  const assistant = current.filter(event => event?.type === 'assistant/message')
  const toolCalls = current.filter(event => event?.type === 'tool/call')
  const toolResults = current.filter(event => event?.type === 'tool/result')
  const content = messageContent(assistant.at(-1)?.data?.message)
  // With user-facing text, the text alone is judged, so reasoning that says "I need to check" does not block a
  // complete answer. Reasoning is judged only as reasoning-only output after tool work. A reasoning-only turn with no
  // tool call before it is not judged, so it passes.
  const judged = content.text || (toolCalls.length > 0 ? content.reasoning : '')
  return {
    assistantMessages: assistant.length,
    toolCalls: toolCalls.length,
    toolResults: toolResults.length,
    text: content.text,
    reasoning: content.reasoning,
    futureIntent: FUTURE_INTENT.some(pattern => pattern.test(judged)),
    reasoningOnlyAfterTools: toolCalls.length > 0 && Boolean(content.reasoning) && !content.text && content.toolCalls === 0,
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
    this.turns = new TurnEvents()
    // The last HEAD read for each nested repository path, so a failed read keeps the identity the path had.
    this.nestedHeads = new Map()
    // The repositories each session changed, held in memory per session (see lib/tracker.js).
    this.repositories = new RepositoryTracker()
    // The last attest call of each session, so the next call of that session starts after it (see attest).
    this.attesting = new Map()
    this.disposers = []
  }

  state(agent) {
    const id = sessionKey(agent)
    if (!this.states.has(id)) this.states.set(id, {
      continuationTurn: 0, continuationBlocks: 0, recoveryPending: false, nudge: null,
    })
    return this.states.get(id)
  }

  applies(agent) { return this.config.gateSubagents || !isSubagent(agent) }

  // Changing settings restarts every session's stop bookkeeping. Claims, item states, and attestations are kept.
  restartStopBookkeeping() {
    for (const state of this.states.values()) {
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
    this.restartStopBookkeeping()
    return settingsSummary(this.config)
  }

  resetSettings() {
    removeSavedSettings(this.settingsPath)
    this.config = resolveConfig(this.profileConfig)
    this.hasSavedSettings = false
    this.restartStopBookkeeping()
    return settingsSummary(this.config)
  }

  // The host change recorder is read without an inject requirement: listing it in `inject`
  // would make it a required dependency and unload this plugin wherever the recorder is not
  // mounted. `ctx.reflect.get` returns undefined instead, which the gate reports as
  // "changes cannot be determined" rather than treating the workspace as unchanged.
  changeService() {
    try { return this.ctx?.reflect?.get?.('workspaceChanges') ?? null } catch { return null }
  }

  // The latest turn this session opened. The tracker advances it from `turn/start`, so a tool
  // call inside a turn resolves that same turn, and the stop handler passes its own turn.
  currentTurn(agent) { return this.changes.lastTurn(sessionKey(agent)) }

  // Resolve what this turn changed, from the host's turn-scoped record. `determined: false`
  // means the source could not be trusted, and the gate says so in its advisory.
  async turnChanges(agent, requestedTurn = null, { stopping = false } = {}) {
    if (!sessionCwd(agent)) throw new Error('Completion Gate requires session.header.cwd')
    const turn = Number.isInteger(requestedTurn) ? requestedTurn : this.currentTurn(agent)
    const id = sessionKey(agent)
    const record = readTurnChanges({
      service: this.changeService(), tracker: this.changes, sessionId: id, turn,
      // The recorder never covers a subagent session, so for one of those a missing announcement
      // means the source is blind rather than that the turn changed nothing.
      recorded: !isSubagent(agent),
      // A missing record reads as "changed nothing" only once the turn has ended (its `turn/end`) or
      // at its stop-time check. Inside an open turn the recorder may simply not have written that
      // turn's record yet. Before any turn has started, the session has made no changes to attribute,
      // so a missing record is accurate.
      inTurn: !stopping && turn > 0 && !this.changes.hasEnded(id, turn),
    })
    // The operator's cap bounds what the gate will handle, but it must not silently exempt the
    // files beyond it from review: a truncated inventory means the complete changed set is
    // unknown, which is reported rather than treated as an unchanged or fully reviewed turn.
    const capped = record.files.length > this.config.maxChangedFiles
    const files = record.files.slice(0, this.config.maxChangedFiles)
    const determined = record.determined && !capped
    const service = this.changeService()
    let addedLines = [], diffGaps = []
    if (determined && record.seq !== null && files.length && service?.diff) {
      const collected = await addedLinesForRecord(service, id, record.seq, files.length, new AbortController().signal)
      addedLines = collected.lines
      diffGaps = collected.gaps
    }
    // The identity covers the changed files and their current bytes, never the record's sequence
    // number, so a later stop that re-records the same change set keeps earlier evidence valid.
    // An undetermined record takes a marker in the sequence slot, so it never shares an identity
    // with a determined record over the same files.
    const base = record.base || sessionCwd(agent)
    const contents = []
    const nested = { heads: this.nestedHeads, unreadable: [], unresolved: [] }
    for (const file of files) contents.push(`${file}\u0000${await contentKey(base, file, nested)}`)
    return {
      turn, sessionId: id,
      seq: record.seq, determined, addedLines, diffGaps, nestedUnreadable: nested.unreadable,
      reason: capped
        ? `This turn changed ${record.files.length} files, over the configured limit of ${this.config.maxChangedFiles}, so the complete set of changed files cannot be determined.`
        : record.reason,
      files,
      fingerprint: changeDigest(id, turn, determined ? null : 'undetermined', contents),
      // The stop's message bound keys on the change set alone (see stopping), so the turn is left out.
      nudgeKey: changeDigest(id, null, determined ? null : 'undetermined', contents),
    }
  }

  // The attest action. It records one repository's claims, reviewed code files, documentation check, and item states, then
  // reports what the repository still owes. A malformed call, an unseen root, or a nested repository with no readable HEAD
  // is refused before anything is stored, and a refused call changes no tracked state. No check starts here.
  async attest(agent, args = {}) {
    const schemaErrors = attestSchemaErrors(args)
    if (schemaErrors.length) throw new AttestRefusal(schemaErrors)
    const id = sessionKey(agent)
    return this.queued(id, () => this.stagedAttest(agent, args, id))
  }

  // Runs one call that changes a session's tracker after the session's earlier such calls settle. Each call stages a copy of
  // the tracker and adopts it when it passes, so an overlapping call would let the later adopt replace the earlier call's
  // claims with its own older copy.
  queued(id, work) {
    const previous = this.attesting.get(id) ?? Promise.resolve()
    const call = previous.then(work)
    this.attesting.set(id, call.catch(() => {}))
    return call
  }

  async stagedAttest(agent, args, id) {
    const staged = this.repositories.stage(id)
    const report = await this.repositoryReport(agent, staged)
    const workspace = await this.turnChanges(agent)
    const { root, workspaceRoot, allowed } = await this.seenRoot(agent, args.repository_root, staged)
    if (!allowed) throw new AttestRefusal([`${root} is not a repository this session has changed, and it is not the session's workspace root (${workspaceRoot}).`])
    const snapshot = staged.repositories(id).find(repo => repo.root === root) ?? { root, files: [], itemStates: [], attestation: null }
    // Only the selected repository's own nested HEAD blocks it. A nested repository elsewhere in the session does not.
    const unresolved = snapshot.files.filter(file => file.key === 'unreadable-nested')
    if (unresolved.length) {
      throw new AttestRefusal(unresolved.map(file => `Nested repository ${file.path} has no readable HEAD yet, so nothing is attested. Attest again once its HEAD reads.`))
    }
    const plan = planAttest(snapshot, args, readCatalog(root))
    staged.applyAttest(id, root, plan, Date.now())
    this.repositories.adopt(id, staged)
    const after = this.repositories.repositories(id).find(repo => repo.root === root)
    const evaluated = evaluateRepository(after, readCatalog(root))
    // Each such item is already unfinished, since its state is not stated, so complete stays false. This sentence names the cause.
    for (const item of plan.items) {
      if (item.state === null) evaluated.problems.push(`${item.id} is marked assumed but has no reason, so it stays unfinished. Attest it again with a reason, or mark it passed once it has run.`)
    }
    const section = repositoriesMarkdown({ turn: report.turn, notices: report.notices, repositories: [evaluated] })
    return {
      pass: evaluated.complete, problems: evaluated.problems, blockers: evaluated.problems, fingerprint: workspace.fingerprint,
      markdown: `# Completion Gate attest\n\n${section}`,
    }
  }

  // Clears this session's claims, item states, and attestations, and its stop bookkeeping. The repository tracker forgets
  // the session, so the next read files the session's turns again with every file unclaimed. No repository, catalog, or
  // file is touched.
  reset(agent) {
    const state = this.state(agent)
    state.continuationTurn = 0
    state.continuationBlocks = 0
    state.recoveryPending = false
    state.nudge = null
    this.repositories.forget(sessionKey(agent))
  }

  premature(agent, turn) {
    if (!this.config.preventPrematureStops) return null
    const state = this.state(agent)
    const evidence = turnEvidence(this.turns.events(sessionKey(agent), turn))
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
    // The stop path reads what this turn changed and the state of every repository the session changed. It runs no check
    // or probe, and it never stops the turn: at most one advisory steer, bounded per change set.
    const id = sessionKey(agent)
    let workspace = null, report = null, failure = ''
    try {
      workspace = await this.turnChanges(agent, turn, { stopping: true })
      report = await this.repositoryReport(agent)
    } catch (error) { failure = cleanText(error?.message || error, 1000) || 'unknown error' }
    const undetermined = failure ? `Completion Gate could not evaluate the workspace: ${failure}.` : (workspace.determined ? null : workspace.reason)
    const credentials = !failure && workspace.determined && this.config.securityScan ? scanSecurity(workspace.addedLines) : []
    const open = failure ? [] : report.repositories.filter(repo => !repo.complete)
    // A nested repository whose HEAD could not be read keeps the identity it had, so the repository can read as complete. The
    // notice says the gate could not check its current commit at this stop, which no repository line above would show. Both
    // the nested repositories this turn changed and the attested ones that the status refresh read are named, once each.
    const unreadable = failure ? [] : [...new Set([...workspace.nestedUnreadable, ...report.nestedUnreadable])]
    // A turn whose files could not be attributed is named, because the gate saw that failure. Its files are in no
    // repository listed below, so the message asks for them to be checked by hand.
    const attribution = failure ? [] : report.attribution.map(item => `Completion Gate could not attribute the changed files of turn ${item.turn} to their repositories: ${item.message}. Those files are not listed below, so check them yourself.`)
    const notices = [...unreadable.map(file => `Nested repository ${file}: could not read its HEAD at this stop, so the gate could not check its current commit.`), ...attribution]
    // The unread-file line belongs to the credential scan, so it is sent only while that scan is on.
    const gaps = failure || !this.config.securityScan ? [] : workspace.diffGaps
    const text = advisoryMessage({ undetermined, notices, repositories: open, credentials, diffGaps: gaps })
    if (!text) return
    // The bound: at most verificationNudgeLimit messages per change set, and none at zero. The change set is the nudge key:
    // the changed files and their current bytes, without the turn, so an unchanged set stays silent on a later turn. A failed
    // evaluation has no change set, so it is keyed by its own error.
    const bound = this.config.verificationNudgeLimit
    if (bound <= 0) return
    const key = failure ? changeDigest(id, null, `error:${failure}`, []) : workspace.nudgeKey
    const state = this.state(agent)
    if (state.nudge?.fingerprint !== key) state.nudge = { fingerprint: key, count: 0 }
    if (state.nudge.count >= bound) return
    state.nudge.count += 1
    agent.steer({ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text }], source: SOURCE })
    // The message reached the session, so the introduction of each repository it named is not shown again.
    for (const repo of open) this.repositories.markIntroduced(id, repo.root)
  }

  // The operator panel's view. The session rows of the panel belong to a later change, so `sessions` is empty here.
  snapshot() {
    return {
      enabled: this.config.enabled,
      gateSubagents: this.config.gateSubagents,
      settings: settingsSummary(this.config),
      profileDefaults: settingsSummary(this.profileConfig),
      hasSavedSettings: this.hasSavedSettings,
      sessions: [],
    }
  }

  // The repositories this session changed. Every turn so far is read from the host's turn record: each record that was
  // read is merged once, then every known file's content key is refreshed. No check runs here. Git runs only to read a
  // changed nested repository's HEAD.
  // The tracker is the one this report reads and changes: attest passes a staged copy, the other callers pass the session's tracker.
  async repositoryReport(agent, tracker = this.repositories) {
    const id = sessionKey(agent)
    const fallback = sessionCwd(agent)
    if (!fallback) throw new Error('Completion Gate requires session.header.cwd')
    const service = this.changeService()
    const current = this.currentTurn(agent)
    const notices = new Set()
    // The turns whose files could not be attributed. The stop path names each one, so the failure is never silent.
    const attribution = []
    // With no recorder no turn can be read. The reason is named even when the session has no turns yet.
    if (!service) notices.add(readTurnChanges({ service, tracker: this.changes, sessionId: id, turn: current }).reason)
    // Outside a git repository the recorder has no baseline, so it lists file-tool edits only and never a shell edit.
    // The spec forbids a message for each quiet turn, so this limit is named once, here.
    try {
      if (!(await gitRootOf(fallback))) notices.add('The session\'s working directory is outside any git repository, so the host change record lists file-tool edits only, and a shell command that changes a file is not listed.')
    } catch (error) {
      notices.add(`Checking whether the session's working directory is inside a git repository failed: ${cleanText(error?.message || error, 300)}.`)
    }
    const nested = { heads: this.nestedHeads, unreadable: [], unresolved: [] }
    for (let turn = 1; turn <= current; turn += 1) {
      const record = readTurnChanges({
        service, tracker: this.changes, sessionId: id, turn,
        recorded: !isSubagent(agent), inTurn: !this.changes.hasEnded(id, turn),
      })
      // An undetermined turn is named, so a blind earlier turn never reads as unchanged.
      if (!record.determined && record.reason) notices.add(record.reason)
      // A truncated record still lists the files it carries, so those are merged, and its notice names the gap.
      if (record.seq !== null && (record.determined || record.truncated)) {
        try {
          await tracker.merge(id, { turn, seq: record.seq, base: record.base, files: record.files, fallback })
        } catch (error) {
          // The turn stays unfiled, and the next status reads it again.
          const message = cleanText(error?.message || error, 300)
          attribution.push({ turn, message })
          notices.add(`Attributing the changed files of turn ${turn} to their repositories failed: ${message}. The next status reads it again.`)
        }
      }
    }
    // A nested repository created after a file was filed owns that file, so each file moves to the root that owns it now.
    await tracker.reroot(id, fallback)
    await tracker.refresh(id, nested)
    // A repository whose recorded files changed after its attestation reopens here, before its obligations are read. The
    // notice names the exception only when the session kept an unrelated mark, so a repository with no mark keeps the
    // wording it always had.
    for (const { root, keptUnrelated } of tracker.reopenChanged(id)) {
      notices.add(keptUnrelated
        ? `Repository ${root} changed after its attestation, so its claims and item states were cleared except those marked unrelated, and the attestation was dropped.`
        : `Repository ${root} changed after its attestation, so its claims and item states were cleared and the attestation was dropped.`)
    }
    for (const file of nested.unreadable) notices.add(`Nested repository ${file}: could not read its HEAD.`)
    // Each repository is judged against its catalog as read from disk now, so status shows what the catalog holds at that moment.
    const repositories = tracker.repositories(id).map(repo => evaluateRepository(repo, readCatalog(repo.root)))
    return { turn: current, notices: [...notices], repositories, nestedUnreadable: nested.unreadable, attribution }
  }

  // The repository a register or attest call names is the root of the path it gives. A root is allowed only when this session
  // has seen it, or when it is the session's workspace root (the owning repository of the working directory).
  async seenRoot(agent, requested, tracker = this.repositories) {
    const fallback = sessionCwd(agent)
    const requestedPath = path.resolve(fallback, String(requested ?? '').trim())
    const root = (await gitRootOf(requestedPath)) ?? requestedPath
    const workspaceRoot = await owningRoot(fallback, fallback)
    return { root, workspaceRoot, allowed: root === workspaceRoot || tracker.has(sessionKey(agent), root) }
  }

  // The register action. It writes verification items into one repository's catalog. The root must be one this session
  // has seen: the session's workspace root, or a repository the session changed. Any other root is refused before anything
  // is written. Like attest, it runs on a staged copy of the tracker, one call at a time per session, so a refused call changes
  // no tracked state. The repository report runs first, so every turn so far is filed before the root is checked. No check starts.
  async register(agent, args = {}) {
    const fallback = sessionCwd(agent)
    if (!fallback) throw new Error('Completion Gate requires session.header.cwd')
    if (typeof args.repository_root !== 'string' || !args.repository_root.trim()) throw new Error('register requires repository_root, the path of a repository this session changed.')
    const id = sessionKey(agent)
    return this.queued(id, async () => {
      const staged = this.repositories.stage(id)
      await this.repositoryReport(agent, staged)
      const { root, workspaceRoot, allowed } = await this.seenRoot(agent, args.repository_root, staged)
      if (!allowed) {
        throw new Error(`register refused: ${root} is not a repository this session has changed, and it is not the session's workspace root (${workspaceRoot}). Nothing was written.`)
      }
      const outcome = await registerItems(root, args.items)
      staged.addRepository(id, root)
      this.repositories.adopt(id, staged)
      return outcome
    })
  }

  // The session report: every repository this session changed, with its files, catalog items, attestation, and what it
  // still owes. It reads recorded state and the repositories, and it starts no check.
  async statusResult(agent) {
    const section = repositoriesMarkdown(await this.repositoryReport(agent))
    return { markdown: `# Completion Gate\n\n${section}` }
  }

  registerTool() {
    return this.ctx.tools.register({
      name: 'completion_gate',
      description: 'Register the verification you run, attest what each changed repository still owes, or read the session report.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['register', 'attest', 'status'] },
          claims: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, decision: { type: 'string', enum: ['mine', 'not-mine'] } }, required: ['path', 'decision'] } },
          reviewed_code_files: { type: 'array', items: { type: 'string' } },
          docs_checked: { type: 'boolean' },
          summary: { type: 'string' },
          repository_root: { type: 'string' },
          items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, state: { type: 'string', enum: [...ITEM_STATES] }, reason: { type: 'string' }, name: { type: 'string' }, proves: { type: 'string' }, command: { type: 'string' } } } },
        }, required: ['action'],
      },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: value.markdown }] },
      execute: async (args, exec) => {
        // Register writes catalog items for one repository the session has seen. It starts no check, and its result carries
        // the catalog path, the item ids, and whether git will ignore the catalog.
        if (args.action === 'register') {
          const registered = await this.register(exec.agent, args)
          return { pass: null, registered, markdown: registerMarkdown(registered) }
        }
        // Status reads recorded state and the repositories only, and never starts a check (see statusResult).
        if (args.action === 'status') return this.statusResult(exec.agent)
        // Attest records the repository's obligations and starts no check, so its result is that repository's own report.
        if (args.action === 'attest') {
          const attested = await this.attest(exec.agent, args)
          return { pass: attested.pass, fingerprint: attested.fingerprint, blockers: attested.blockers, markdown: attested.markdown }
        }
        throw new Error(`completion_gate takes three actions: register, attest, and status. "${args.action}" is not one of them, so nothing was changed.`)
      },
    })
  }

  registerCommands() {
    const registrations = []
    const register = (definition) => { try { registrations.push(this.ctx.commands.register(definition)) } catch {} }
    // /gate and /gate-status show the same session report as the status action. Neither starts a check.
    const report = async invocation => {
      if (!invocation.agent) return { kind: 'error', text: 'No active agent.' }
      return { kind: 'success', text: (await this.statusResult(invocation.agent)).markdown }
    }
    register({ name: 'gate', description: 'Show the Completion Gate report for this session.', handler: report })
    register({ name: 'gate-status', description: 'Show the Completion Gate report for this session.', handler: report })
    register({ name: 'gate-reset', description: 'Clear this session Completion Gate claims and attestations. No repository is touched.', handler: invocation => {
      if (!invocation.agent) return { kind: 'error', text: 'No active agent.' }
      this.reset(invocation.agent)
      return { kind: 'success', text: '# Completion Gate\n\nThis session claims and attestations were cleared. No repository, catalog, or file was touched.' }
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
    try { this.disposers.push(this.ctx.provide('completionGate', { snapshot: () => this.snapshot() })) } catch {}
    this.disposers.push(this.registerTool())
    this.disposers.push(...this.registerCommands())
    this.disposers.push(this.ctx.systemPrompt.section({
      name: 'tool:completion-gate', order: 188,
      text: 'For code-changing tasks, Completion Gate tracks every repository you change. Register the verification you run, claim or reject each changed file, and call completion_gate with action=attest for each changed repository. Do not voluntarily stop immediately after stating pending work such as “now I need”, “next I will”, or “let me inspect”; execute those actions first. Never end on reasoning-only output after tool use.',
    }))
    // One session/event listener feeds both the changed-file source (the host recorder's `workspace/changes` sequence per
    // turn) and the turn events the premature-stop guard reads. A disposed session's records are forgotten.
    this.disposers.push(this.ctx.on('session/event', (session, event) => { this.changes.observe(session, event); this.turns.observe(session, event) }))
    this.disposers.push(this.ctx.on('session/disposed', session => { const id = String(session?.id ?? ''); this.changes.forget(id); this.turns.forget(id); this.repositories.forget(id); this.attesting.delete(id) }))
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
