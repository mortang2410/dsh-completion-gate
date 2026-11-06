import path from 'node:path'
import { contentKey } from './changes.js'
import { absoluteOf, owningRoot } from './repositories.js'

// The per-session, in-memory record of the files each repository holds for one session. One repository entry per
// root, one file entry per absolute path within it. Every file starts unclaimed. Nothing is written to disk, and
// session disposal forgets the session (see the session/disposed listener in lib/index.js).
export class RepositoryTracker {
  constructor() { this.sessions = new Map() }

  session(sessionId, create = false) {
    const id = String(sessionId ?? '')
    let entry = this.sessions.get(id)
    if (!entry && create) this.sessions.set(id, entry = { repos: new Map(), merged: new Set() })
    return entry ?? null
  }

  // Merge one turn's changed-file list into the session. A (turn, sequence) pair is merged once, so a later
  // evaluation of the same record changes nothing. The caller passes only a record that was read. The pair is
  // marked before the first await, so two evaluations that start together cannot merge it twice.
  // Returns true when the record was merged now, false when it was merged before.
  async merge(sessionId, { turn, seq, base, files, fallback }) {
    const entry = this.session(sessionId, true)
    const key = `${Number(turn)}:${Number(seq)}`
    if (entry.merged.has(key)) return false
    entry.merged.add(key)
    const fallbackRoot = path.resolve(String(fallback))
    const recordBase = base ? String(base) : fallbackRoot
    // Every repository is resolved before any file is filed, so a failed lookup files nothing from this turn.
    const resolved = []
    try {
      for (const file of files) {
        const durable = String(file)
        const absolute = absoluteOf(recordBase, durable)
        resolved.push({ durable, absolute, root: await owningRoot(absolute, fallbackRoot) })
      }
    } catch (error) {
      entry.merged.delete(key)
      throw error
    }
    for (const { durable, absolute, root } of resolved) {
      let repo = entry.repos.get(root)
      if (!repo) entry.repos.set(root, repo = { root, files: new Map() })
      let record = repo.files.get(absolute)
      if (!record) repo.files.set(absolute, record = { absolute, claim: 'unclaimed', key: null, path: durable, base: recordBase })
      // The latest durable path and base win, so a later turn's record describes the file as it was last reported.
      record.path = durable
      record.base = recordBase
    }
    return true
  }

  // Recompute the content key of every known file. The key covers the file's bytes now, so a later edit shows up
  // as a new key on the next evaluation.
  async refresh(sessionId, nested = { heads: new Map(), unreadable: [], unresolved: [], unborn: [] }) {
    const entry = this.session(sessionId)
    if (!entry) return
    for (const repo of entry.repos.values()) {
      for (const file of repo.files.values()) file.key = await contentKey(file.base, file.path, nested)
    }
  }

  // The repositories of one session, sorted by root, each with its files sorted by absolute path.
  repositories(sessionId) {
    const entry = this.session(sessionId)
    if (!entry) return []
    return [...entry.repos.keys()].sort().map(root => {
      const repo = entry.repos.get(root)
      return {
        root,
        label: path.basename(root) || root,
        catalogPath: path.join(root, '.dsh', 'verification.json'),
        files: [...repo.files.keys()].sort().map(absolute => {
          const file = repo.files.get(absolute)
          return { path: file.path, absolute: file.absolute, claim: file.claim, key: file.key }
        }),
      }
    })
  }

  forget(sessionId) { this.sessions.delete(String(sessionId ?? '')) }
}
