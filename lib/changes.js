import crypto from 'node:crypto'
import fs from 'node:fs'
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

// Attestation identity and evidence freshness bind to what the turn changed: the listed files and
// each file's current contents (see contentKey). The record's sequence number is not part of the
// identity, so a later stop that re-records the same change set keeps a valid pass, while a real
// edit invalidates it. Touching a file without changing its bytes does not.
export function changeDigest(sessionId, turn, seq, files) {
  const hash = crypto.createHash('sha256')
  hash.update(String(sessionId ?? ''))
  hash.update(String(turn ?? ''))
  hash.update(String(seq ?? 'none'))
  for (const file of Array.isArray(files) ? [...files].map(String).sort() : []) hash.update(`\u0000${file}`)
  return hash.digest('hex')
}

// The current content of one changed file, for the evidence identity. A regular file contributes a
// SHA-256 of its bytes. A deletion or a directory contributes a fixed marker, and so does a special
// file, which is never read because reading a FIFO can block. A symbolic link contributes its target
// text and is not followed. `base` is the directory the recorder reports the path against.
export async function contentKey(base, file) {
  if (!base) return 'unresolved'
  const absolute = path.resolve(String(base), String(file ?? ''))
  let stat
  try { stat = await fs.promises.lstat(absolute) }
  catch (error) { return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'absent' : `unreadable:${error?.code ?? 'error'}` }
  if (stat.isSymbolicLink()) {
    try { return `link:${await fs.promises.readlink(absolute)}` }
    catch (error) { return `unreadable:${error?.code ?? 'error'}` }
  }
  if (stat.isDirectory()) return 'directory'
  if (!stat.isFile()) return 'special'
  const hash = crypto.createHash('sha256')
  try { for await (const chunk of fs.createReadStream(absolute)) hash.update(chunk) }
  catch (error) { return `unreadable:${error?.code ?? 'error'}` }
  return `file:${hash.digest('hex')}`
}

export class ChangeTracker {
  constructor() { this.sessions = new Map() }

  entry(sessionId, create = false) {
    const id = String(sessionId ?? '')
    if (!id) return null
    let entry = this.sessions.get(id)
    if (!entry && create) this.sessions.set(id, entry = { turns: new Map(), lastTurn: 0, endedTurn: 0 })
    return entry ?? null
  }

  observe(session, event) {
    const id = String(session?.id ?? '')
    const type = event?.type
    if (!id || (type !== 'workspace/changes' && type !== 'turn/start' && type !== 'turn/end')) return
    const turn = Number(event?.data?.turn)
    if (!Number.isInteger(turn)) return
    const entry = this.entry(id, true)
    // The host appends `turn/end` after the stop hook and after any steered continuation, so it is
    // the only event that closes a turn. Turns are numbered in order, so one end covers the earlier ones.
    if (type === 'turn/end') { if (turn > entry.endedTurn) entry.endedTurn = turn; return }
    if (turn > entry.lastTurn) entry.lastTurn = turn
    if (type !== 'workspace/changes') return
    const seq = Number(event?.seq)
    if (!Number.isInteger(seq)) return
    const previous = entry.turns.get(turn)
    if (previous === undefined || seq > previous) entry.turns.set(turn, seq)
  }

  seqFor(sessionId, turn) { return this.entry(sessionId)?.turns.get(Number(turn)) }
  lastTurn(sessionId) { return this.entry(sessionId)?.lastTurn ?? 0 }
  hasEnded(sessionId, turn) { return Number(turn) <= (this.entry(sessionId)?.endedTurn ?? 0) }
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
//
// `inTurn` says the turn is still open: the call runs before its stop, or the host has not appended
// its `turn/end` yet. Then a missing record means the recorder has not written one yet, so nothing is
// known about this turn's changes: the set is undetermined. Once the turn has ended, a missing record
// means the turn changed nothing, which is what a stop-time call reads too.
export function readTurnChanges({ service, tracker, sessionId, turn, recorded = true, inTurn = false }) {
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
    if (inTurn) {
      return {
        determined: false, files: [], seq: null, turn,
        reason: `The host change record for turn ${turn} has not been written yet, so the files this turn has changed cannot be determined until the turn stops.`,
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
  // The recorder reports each path relative to the directory it recorded in, which is `base`.
  const base = typeof summary.cwd === 'string' ? summary.cwd : ''
  const files = (Array.isArray(summary.files) ? summary.files : []).map(file => String(file?.path ?? '')).filter(Boolean)
  // The recorder caps the list it carries but reports the complete count in `total`. When those
  // disagree, files this turn changed are absent from the record, so it cannot be treated as a
  // complete inventory: the gate must say the set is truncated rather than attest around the gap.
  const total = Number.isInteger(summary.total) ? summary.total : files.length
  if (total > files.length) {
    return {
      determined: false, files, seq, turn, total, truncated: true, base,
      reason: `This turn changed ${total} files and the host change record carries only ${files.length} of them, so the complete set of changed files cannot be determined.`,
    }
  }
  return { determined: true, files, seq, turn, total, base }
}
