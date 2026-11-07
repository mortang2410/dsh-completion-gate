import crypto from 'node:crypto'
import path from 'node:path'
import { contentKey, isDocumentationPath } from './changes.js'
import { absoluteOf, owningRoot } from './repositories.js'

// The per-session, in-memory record of what each repository holds for one session. One repository entry per root. Each
// repository keeps its changed files (each with a claim), the catalog item states the model reported, and one
// attestation bound to a digest of the files. Every file starts unclaimed. Nothing is written to disk, and session disposal
// forgets the session (see the session/disposed listener in lib/index.js).
export class RepositoryTracker {
  constructor() { this.sessions = new Map() }

  session(sessionId, create = false) {
    const id = String(sessionId ?? '')
    let entry = this.sessions.get(id)
    if (!entry && create) this.sessions.set(id, entry = { repos: new Map(), merged: new Map() })
    return entry ?? null
  }

  // Merge one turn's changed-file list into the session. A (turn, sequence) pair is merged once, so a later
  // evaluation of the same record changes nothing. The caller passes only a record that was read. The pair's filing
  // is stored under its key before the first await. An evaluation that finds a filing still in flight waits for it,
  // so every read returns with the turn's repositories already filed.
  // Returns true when this call filed the record, false when the record was filed before this call.
  async merge(sessionId, { turn, seq, base, files, fallback }) {
    const entry = this.session(sessionId, true)
    const key = `${Number(turn)}:${Number(seq)}`
    const inFlight = entry.merged.get(key)
    if (inFlight) { await inFlight; return false }
    const filing = this.fileTurn(entry, { base, files, fallback })
    entry.merged.set(key, filing)
    try { await filing } catch (error) { entry.merged.delete(key); throw error }
    return true
  }

  // Resolves the repository of every changed file, then files them all. A failed lookup throws before any file is filed,
  // so a failed turn leaves nothing behind and the next read files it again.
  async fileTurn(entry, { base, files, fallback }) {
    const fallbackRoot = path.resolve(String(fallback))
    const recordBase = base ? String(base) : fallbackRoot
    const resolved = []
    for (const file of files) {
      const durable = String(file)
      const absolute = absoluteOf(recordBase, durable)
      resolved.push({ durable, absolute, root: await owningRoot(absolute, fallbackRoot) })
    }
    for (const { durable, absolute, root } of resolved) {
      let repo = entry.repos.get(root)
      if (!repo) entry.repos.set(root, repo = newRepo(root))
      let record = repo.files.get(absolute)
      if (!record) repo.files.set(absolute, record = { absolute, claim: 'unclaimed', key: null, path: durable, base: recordBase })
      // The latest durable path and base win, so a later turn's record describes the file as it was last reported.
      record.path = durable
      record.base = recordBase
    }
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

  // Moves every known file to the repository that owns it now. A nested repository created after a file was filed owns
  // that file from then on. The file keeps its claim unless it is unclaimed under the new root. A repository this pass
  // emptied, with no item state and no attestation, is dropped.
  async reroot(sessionId, fallback) {
    const entry = this.session(sessionId)
    if (!entry) return
    const fallbackRoot = path.resolve(String(fallback))
    for (const repo of [...entry.repos.values()]) {
      let moved = false
      for (const file of [...repo.files.values()]) {
        const root = await owningRoot(file.absolute, fallbackRoot)
        if (root === repo.root) continue
        if (!entry.repos.has(root)) entry.repos.set(root, newRepo(root))
        const target = entry.repos.get(root)
        const existing = target.files.get(file.absolute)
        if (existing) { if (existing.claim === 'unclaimed') existing.claim = file.claim }
        else target.files.set(file.absolute, file)
        repo.files.delete(file.absolute)
        moved = true
      }
      if (moved && repo.files.size === 0 && repo.items.size === 0 && !repo.attestation) entry.repos.delete(repo.root)
    }
  }

  // Whether this session holds a repository entry for the root, that is, whether the session has seen that repository.
  has(sessionId, root) { return Boolean(this.session(sessionId)?.repos.has(root)) }

  // Adds an entry for a root with no changed file, so status lists a repository the register action wrote a catalog into.
  addRepository(sessionId, root) {
    const entry = this.session(sessionId, true)
    if (!entry.repos.has(root)) entry.repos.set(root, newRepo(root))
  }

  // Binds an attestation to the repository's current digest. The claims and item states of the plan are merged in: a
  // claim changes only the paths it names, and an item changes only the ids it names. The attestation itself replaces the
  // earlier one.
  applyAttest(sessionId, root, plan, createdAt) {
    const entry = this.session(sessionId, true)
    if (!entry.repos.has(root)) entry.repos.set(root, newRepo(root))
    const repo = entry.repos.get(root)
    for (const claim of plan.claims) repo.files.get(claim.absolute).claim = claim.decision
    for (const item of plan.items) repo.items.set(item.id, { state: item.state, reason: item.reason })
    repo.attestation = {
      digest: repositoryDigest(repo), reviewed: [...new Set(plan.reviewed)], docsChecked: plan.docsChecked, summary: plan.summary ?? '', createdAt,
    }
  }

  // Reopens every repository whose files no longer match the digest its attestation was bound to. A reopened repository has
  // every claim set back to unclaimed, its item states cleared, and its attestation dropped. Returns the reopened roots,
  // sorted. A repository with no attestation is never reopened here.
  reopenChanged(sessionId) {
    const entry = this.session(sessionId)
    if (!entry) return []
    const roots = []
    for (const repo of entry.repos.values()) {
      if (!repo.attestation || repo.attestation.digest === repositoryDigest(repo)) continue
      for (const file of repo.files.values()) file.claim = 'unclaimed'
      repo.items.clear()
      repo.attestation = null
      roots.push(repo.root)
    }
    return roots.sort()
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
          return { path: file.path, absolute: file.absolute, claim: file.claim, key: file.key, documentation: isDocumentationPath(file.path) }
        }),
        itemStates: [...repo.items].map(([id, item]) => ({ id, state: item.state, reason: item.reason })),
        attestation: repo.attestation,
      }
    })
  }

  forget(sessionId) { this.sessions.delete(String(sessionId ?? '')) }

  // A copy of one session's entry, for an attest call to change and then hand to adopt. Nothing in the copy is shared with
  // this tracker, so a call that refuses drops its copy and leaves this tracker as it was. The copy starts with no merged
  // turns: a filing still in flight writes into this tracker's entry, not the copy, so a copy that inherited it would
  // count that turn as filed while its files were missing. Re-filing a turn is idempotent, so the copy files it again.
  stage(sessionId) {
    const copy = new RepositoryTracker()
    const entry = this.session(sessionId)
    if (!entry) return copy
    const repos = new Map([...entry.repos].map(([root, repo]) => [root, {
      root: repo.root,
      files: new Map([...repo.files].map(([absolute, file]) => [absolute, { ...file }])),
      items: new Map([...repo.items].map(([id, item]) => [id, { ...item }])),
      attestation: repo.attestation ? { ...repo.attestation, reviewed: [...repo.attestation.reviewed] } : null,
    }]))
    copy.sessions.set(String(sessionId ?? ''), { repos, merged: new Map() })
    return copy
  }

  // Replaces this tracker's entry for the session with the staged copy's entry, when the copy has one.
  adopt(sessionId, staged) {
    const entry = staged.session(sessionId)
    if (entry) this.sessions.set(String(sessionId ?? ''), entry)
  }
}

function newRepo(root) { return { root, files: new Map(), items: new Map(), attestation: null } }

// The digest an attestation is bound to: the sorted absolute paths of the repository's files, each with its content key. The
// claims and the item states are not part of it, so a claim or a catalog item can change without reopening the repository.
export function repositoryDigest(repo) {
  const hash = crypto.createHash('sha256')
  for (const absolute of [...repo.files.keys()].sort()) hash.update(`${absolute}\u0000${repo.files.get(absolute).key ?? ''}\n`)
  return hash.digest('hex')
}

// A refused attest call. Nothing is stored when it is thrown. The message lists every error, so one call shows all of them.
export class AttestRefusal extends Error {
  constructor(errors) {
    super(`attest refused. Nothing was changed.\n${errors.map(error => `- ${error}`).join('\n')}`)
    this.name = 'AttestRefusal'
    this.errors = errors
  }
}

const ATTEST_KEYS = new Set(['action', 'repository_root', 'claims', 'reviewed_code_files', 'docs_checked', 'items', 'summary'])
const CLAIM_KEYS = new Set(['path', 'decision'])
const ITEM_KEYS = new Set(['id', 'state', 'reason'])
const DECISIONS = new Set(['mine', 'not-mine'])
const ITEM_STATES = new Set(['passed', 'assumed'])
const text = value => typeof value === 'string' && value.trim() !== ''

// The schema errors of one attest call, with no repository state read. An empty list means the shape is valid. A key the
// call does not allow is an error, so a retired argument is refused instead of ignored. An omitted array field counts as
// empty; an explicit null is refused like any other value of the wrong type.
export function attestSchemaErrors(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ['attest takes one object of arguments.']
  const errors = []
  for (const key of Object.keys(args)) if (!ATTEST_KEYS.has(key)) errors.push(`Unknown argument: ${key}.`)
  if (!text(args.repository_root)) errors.push('repository_root is required: the path of a repository this session changed.')
  const claims = args.claims === undefined ? [] : args.claims
  if (!Array.isArray(claims)) errors.push('claims must be an array of {path, decision} objects.')
  else {
    const seen = new Set()
    claims.forEach((claim, index) => {
      if (!claim || typeof claim !== 'object' || Array.isArray(claim)) { errors.push(`claims[${index}] must be an object.`); return }
      for (const key of Object.keys(claim)) if (!CLAIM_KEYS.has(key)) errors.push(`claims[${index}] has an unknown key: ${key}.`)
      if (!text(claim.path)) errors.push(`claims[${index}].path is required.`)
      else if (seen.has(claim.path)) errors.push(`claims[${index}].path repeats ${claim.path}.`)
      else seen.add(claim.path)
      if (!DECISIONS.has(claim.decision)) errors.push(`claims[${index}].decision must be mine or not-mine.`)
    })
  }
  const reviewed = args.reviewed_code_files === undefined ? [] : args.reviewed_code_files
  if (!Array.isArray(reviewed) || reviewed.some(p => !text(p))) errors.push('reviewed_code_files must be an array of non-empty paths.')
  if (args.docs_checked !== undefined && typeof args.docs_checked !== 'boolean') errors.push('docs_checked must be true or false.')
  if (args.summary !== undefined && typeof args.summary !== 'string') errors.push('summary must be a string.')
  const items = args.items === undefined ? [] : args.items
  if (!Array.isArray(items)) errors.push('items must be an array of {id, state, reason} objects.')
  else {
    const ids = new Set()
    items.forEach((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`items[${index}] must be an object.`); return }
      for (const key of Object.keys(item)) if (!ITEM_KEYS.has(key)) errors.push(`items[${index}] has an unknown key: ${key}.`)
      if (!text(item.id)) errors.push(`items[${index}].id is required.`)
      else if (ids.has(item.id)) errors.push(`items[${index}].id repeats ${item.id}.`)
      else ids.add(item.id)
      if (!ITEM_STATES.has(item.state)) errors.push(`items[${index}].state must be passed or assumed.`)
      if (item.reason !== undefined && typeof item.reason !== 'string') errors.push(`items[${index}].reason must be a string.`)
      if (item.state === 'passed' && item.reason !== undefined) errors.push(`items[${index}] is passed, so it takes no reason.`)
    })
  }
  return errors
}

// Resolves the paths of one attest call against the repository's changed files and checks the item ids against the
// catalog. It returns the plan to apply, or throws AttestRefusal listing every error. It reads no file and stores nothing.
export function planAttest(snapshot, args, catalogState) {
  const errors = []
  const known = new Set(snapshot.files.map(file => file.absolute))
  const absoluteFor = raw => {
    const absolute = path.resolve(snapshot.root, String(raw))
    if (!known.has(absolute)) errors.push(`${raw} is not a changed file of this repository.`)
    return absolute
  }
  const claims = (args.claims ?? []).map(claim => ({ absolute: absoluteFor(claim.path), decision: claim.decision }))
  const reviewed = (args.reviewed_code_files ?? []).map(absoluteFor)
  const items = args.items ?? []
  if (items.length && catalogState.state === 'unreadable') errors.push(`The catalog cannot be read: ${catalogState.problem}.`)
  else for (const item of items) if (!catalogState.items.some(entry => entry.id === item.id)) errors.push(`${item.id} is not an item in this repository's catalog.`)
  // An unreadable file keeps the same content key whatever its bytes become, so an attestation over it would not reopen
  // when the file changes. Such a file is refused instead.
  for (const file of snapshot.files) {
    if (file.key.startsWith('unreadable:')) errors.push(`${file.absolute} cannot be read (${file.key.slice('unreadable:'.length)}), so nothing is attested. Make it readable, then attest again.`)
  }
  if (errors.length) throw new AttestRefusal(errors)
  return {
    claims,
    reviewed,
    docsChecked: args.docs_checked === true,
    // An assumed item with no reason is unreported: it stays in the plan with no state, so applying it clears any earlier state.
    items: items.map(item => (item.state === 'assumed' && !text(item.reason)
      ? { id: item.id, state: null }
      : { id: item.id, state: item.state, ...(item.state === 'assumed' ? { reason: item.reason } : {}) })),
    summary: args.summary,
  }
}

// The obligations of one repository, from its snapshot (an entry of repositories) and its catalog as read from disk. Every
// problem is a sentence the report prints as it is. The repository is complete when no problem is left.
export function evaluateRepository(snapshot, catalogState) {
  const problems = []
  const attestation = snapshot.attestation
  const unclaimed = snapshot.files.filter(file => file.claim === 'unclaimed').map(file => file.absolute)
  if (unclaimed.length) problems.push(`Unclaimed changed files: ${unclaimed.join(', ')}. Claim each as yours, or reject it.`)
  const reviewed = new Set(attestation?.reviewed ?? [])
  const unreviewed = snapshot.files.filter(file => file.claim === 'mine' && !file.documentation && !reviewed.has(file.absolute)).map(file => file.absolute)
  if (unreviewed.length) problems.push(`Claimed code files not reviewed: ${unreviewed.join(', ')}.`)
  const docs = snapshot.files.filter(file => file.documentation && file.claim !== 'not-mine').map(file => file.absolute)
  if (docs.length && attestation?.docsChecked !== true) problems.push(`Changed documentation not checked: ${docs.join(', ')}. Check each for staleness, bloat, and conflicting information, then attest with docs_checked true.`)
  if (catalogState.state === 'unreadable') problems.push(`The catalog cannot be read: ${catalogState.problem}.`)
  const stated = new Map(snapshot.itemStates.map(item => [item.id, item]))
  const items = catalogState.items.map(item => ({ id: item.id, name: item.name, state: stated.get(item.id)?.state ?? null, reason: stated.get(item.id)?.reason }))
  for (const item of items) if (!item.state) problems.push(`Catalog item not stated: ${item.id} (${item.name}).`)
  if (!attestation) problems.push('No current attestation for this repository.')
  return { ...snapshot, catalog: catalogState, items, problems, complete: problems.length === 0 }
}
