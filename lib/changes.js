import crypto from 'node:crypto'
import path from 'node:path'

// Turn-scoped changed-file source for the completion gate.
//
// The host's `@deepseek-ai/dsh-workspace-changes` recorder snapshots the working tree
// at turn start and turn end through a private git index and diffs the two trees, so a
// file that was already dirty before the turn is part of the baseline and is NOT
// attributed to the turn, while a file written by any process inside the repository
// during the turn (including a shell command) IS. The gate reads that record instead of
// running its own `git status`, which could not separate pre-existing dirt from a session edit.
//
// The record is keyed by the sequence number of the `workspace/changes` Session event,
// never by the turn number, so the tracker keeps the highest sequence seen per turn.

const DOCUMENTATION_EXTENSIONS = Object.freeze([
  '.md', '.markdown', '.mdx', '.rst', '.txt', '.text', '.adoc', '.asciidoc', '.org', '.log', '.csv', '.tsv',
])
const DOCUMENTATION_BASENAMES = Object.freeze([
  'license', 'licence', 'notice', 'authors', 'contributors', 'changelog', 'codeowners',
])

export function isDocumentationPath(file) {
  const base = path.basename(String(file ?? ''))
  if (!base) return false
  if (DOCUMENTATION_EXTENSIONS.includes(path.extname(base).toLowerCase())) return true
  return path.extname(base) === '' && DOCUMENTATION_BASENAMES.includes(base.toLowerCase())
}

// A documentation-only turn exempts the gate from behavioral verification. Zero changed
// paths is not a documentation-only turn: there is nothing to exempt and nothing to verify.
export function isDocumentationOnly(files) {
  const list = Array.isArray(files) ? files : []
  return list.length > 0 && list.every(isDocumentationPath)
}

// Attestation identity and evidence freshness both bind to the turn-scoped change record,
// never to a repository content hash: touching a file or writing build output must not
// invalidate a valid pass, while a real edit in a later turn must.
export function changeDigest(sessionId, turn, seq, files) {
  const hash = crypto.createHash('sha256')
  hash.update(String(sessionId ?? ''))
  hash.update(String(turn ?? ''))
  hash.update(String(seq ?? 'none'))
  for (const file of Array.isArray(files) ? [...files].map(String).sort() : []) hash.update(`\u0000${file}`)
  return hash.digest('hex')
}

export class ChangeTracker {
  constructor() { this.sessions = new Map() }

  entry(sessionId, create = false) {
    const id = String(sessionId ?? '')
    if (!id) return null
    let entry = this.sessions.get(id)
    if (!entry && create) this.sessions.set(id, entry = { turns: new Map(), lastTurn: 0 })
    return entry ?? null
  }

  observe(session, event) {
    const id = String(session?.id ?? '')
    const type = event?.type
    if (!id || (type !== 'workspace/changes' && type !== 'turn/start')) return
    const turn = Number(event?.data?.turn)
    if (!Number.isInteger(turn)) return
    const entry = this.entry(id, true)
    if (turn > entry.lastTurn) entry.lastTurn = turn
    if (type !== 'workspace/changes') return
    const seq = Number(event?.seq)
    if (!Number.isInteger(seq)) return
    const previous = entry.turns.get(turn)
    if (previous === undefined || seq > previous) entry.turns.set(turn, seq)
  }

  seqFor(sessionId, turn) { return this.entry(sessionId)?.turns.get(Number(turn)) }
  lastTurn(sessionId) { return this.entry(sessionId)?.lastTurn ?? 0 }
  forget(sessionId) { this.sessions.delete(String(sessionId ?? '')) }
}

// Resolve the changed files for one turn. Two outcomes:
//   determined true  -> the host summary was read, or the host announced none for this turn
//   determined false -> the source cannot be trusted (absent service, failed read, or a session
//                       the recorder never covers), so the gate says so rather than assuming the
//                       workspace did not change
//
// Announcing no summary is the recorder's normal silence for a turn that changed nothing:
// it skips the event when its changed-file list is empty. Measured on this host, turns that
// ran dozens of tool calls and changed nothing announced no event at all, so a missing
// record is not evidence of a broken source and must not block on its own.
//
// `recorded` says whether the recorder covers this session at all. It excludes subagent
// sessions entirely (its `eligible()` refuses origin `subagent` or delegationDepth > 0), and it
// also never records a working directory outside a git repository's snapshots. For such a
// session "no announcement" means the source is blind, not that the turn changed nothing, so the
// caller passes recorded=false and the gate reports the change set as undetermined.
export function readTurnChanges({ service, tracker, sessionId, turn, recorded = true }) {
  if (!service || typeof service.summary !== 'function') {
    return {
      determined: false, files: [], seq: null, turn,
      reason: 'The host change recorder (workspaceChanges) is not available, so the files this turn changed cannot be determined.',
    }
  }
  const seq = tracker.seqFor(sessionId, turn)
  if (seq === undefined) {
    if (!recorded) {
      return {
        determined: false, files: [], seq: null, turn,
        reason: `The host change recorder does not record this session, so the files turn ${turn} changed cannot be determined.`,
      }
    }
    return { determined: true, files: [], seq: null, turn }
  }
  let summary
  try { summary = service.summary(sessionId, seq) }
  catch (error) {
    return {
      determined: false, files: [], seq, turn,
      reason: `Reading the host change record for turn ${turn} failed: ${String(error?.message || error)}.`,
    }
  }
  if (!summary) {
    return {
      determined: false, files: [], seq, turn,
      reason: `The host change record for turn ${turn} (sequence ${seq}) is no longer available, so the files this turn changed cannot be determined.`,
    }
  }
  const files = (Array.isArray(summary.files) ? summary.files : []).map(file => String(file?.path ?? '')).filter(Boolean)
  // The recorder caps the list it carries but reports the complete count in `total`. When those
  // disagree, files this turn changed are absent from the record, so it cannot be treated as a
  // complete inventory: the gate must say the set is truncated rather than attest around the gap.
  const total = Number.isInteger(summary.total) ? summary.total : files.length
  if (total > files.length) {
    return {
      determined: false, files, seq, turn, total, truncated: true,
      reason: `This turn changed ${total} files and the host change record carries only ${files.length} of them, so the complete set of changed files cannot be determined.`,
    }
  }
  return { determined: true, files, seq, turn, total }
}
