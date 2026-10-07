import { cleanText } from './core.js'

// Verification ledger, following Hermes: a passing verification is recorded once and stays
// fresh until a later turn edits the same workspace. Freshness is decided by the turn-scoped
// change record, never by a repository content hash, so touching a file or writing ignored
// build output does not invalidate a pass while a real edit in a later turn does.

export const LEDGER_SOURCES = Object.freeze(['check', 'recipe', 'temporary'])

// One row per verification run: where the evidence came from, what it covered, whether it
// passed, bounded output, and the turn-scoped change record it was earned against.
export function ledgerRow({ source, name = '', kind = '', scope = 'targeted', pass = false, turn = null, seq = null, fingerprint = '', output = '', detail = '' }) {
  return {
    source: LEDGER_SOURCES.includes(source) ? source : 'check',
    name: cleanText(name, 200),
    kind: cleanText(kind, 60),
    scope: scope === 'full' ? 'full' : 'targeted',
    pass: pass === true,
    turn: Number.isInteger(turn) ? turn : null,
    seq: Number.isInteger(seq) ? seq : null,
    fingerprint: cleanText(fingerprint, 200),
    output: cleanText(output, 4000),
    detail: cleanText(detail, 1000),
    recordedAt: Date.now(),
  }
}

export class VerificationLedger {
  constructor() { this.rows = new Map() }

  rowsFor(sessionId) { return this.rows.get(String(sessionId ?? '')) ?? [] }

  record(sessionId, row) {
    const id = String(sessionId ?? '')
    const rows = this.rows.get(id) ?? []
    rows.push(row)
    this.rows.set(id, rows)
    return row
  }

  // A row satisfies the machine-verification requirement when it passed at full scope and no
  // LATER change record for the session shows an edit. "Later" is decided by the record the
  // row was earned against: a differing fingerprint means the workspace moved on, so the row
  // describes an older state of the code and is stale.
  fresh(sessionId, fingerprint, { requireFullScope = true } = {}) {
    return this.rowsFor(sessionId).filter(row => row.pass
      && (!requireFullScope || row.scope === 'full')
      && row.fingerprint === fingerprint)
  }

  satisfied(sessionId, fingerprint, options) { return this.fresh(sessionId, fingerprint, options).length > 0 }

  // The most recent row, whatever its outcome, so a failure can be reported with its output.
  latest(sessionId) {
    const rows = this.rowsFor(sessionId)
    return rows.length ? rows[rows.length - 1] : null
  }

  clear(sessionId) { this.rows.delete(String(sessionId ?? '')) }
  clearAll() { this.rows.clear() }

  summary(sessionId, fingerprint) {
    const rows = this.rowsFor(sessionId)
    const fresh = this.fresh(sessionId, fingerprint)
    return {
      total: rows.length,
      fresh: fresh.length,
      satisfied: fresh.length > 0,
      latest: this.latest(sessionId),
    }
  }
}
