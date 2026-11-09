import crypto from 'node:crypto'
import path from 'node:path'
import { contentKey, isDocumentationPath } from './changes.js'
import { absoluteOf, owningRoot } from './repositories.js'

// The per-session, in-memory record of what each repository holds for one session. One repository entry per root. Each
// repository keeps its changed files (each with a claim and two evidence states, reviewed and demonstrated), the catalog
// item states the model reported, and one attestation bound to a digest of the files. Every file starts unclaimed and
// unreviewed. Nothing is written to disk, and session disposal forgets the session (see the session/disposed listener in
// lib/index.js).
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
      if (!record) repo.files.set(absolute, record = { absolute, claim: 'unclaimed', reviewed: false, demonstrated: null, key: null, path: durable, base: recordBase })
      // The latest durable path and base win, so a later turn's record describes the file as it was last reported.
      record.path = durable
      record.base = recordBase
    }
  }

  // Recompute the content key of every known file. The key covers the file's bytes now, so a later edit shows up
  // as a new key on the next evaluation.
  async refresh(sessionId, nested = { heads: new Map(), unreadable: [], unresolved: [] }) {
    const entry = this.session(sessionId)
    if (!entry) return
    for (const repo of entry.repos.values()) {
      for (const file of repo.files.values()) file.key = await contentKey(file.base, file.path, nested)
    }
  }

  // Moves every known file to the repository that owns it now. A nested repository created after a file was filed owns
  // that file from then on. The file keeps its claim unless it is unclaimed under the new root, and it is unreviewed and
  // undemonstrated there, because both belong to the attestation of the repository the file was in. A repository this pass emptied,
  // with no item state and no attestation, is dropped.
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
        else target.files.set(file.absolute, { ...file, reviewed: false, demonstrated: null })
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

  // Binds an attestation to the repository's current digest and marks the files it covers reviewed, and the files it
  // reports demonstrated with the note given. The claims and item states of the plan are merged in: a claim changes only
  // the paths it names, and an item changes only the ids it names. The attestation itself replaces the earlier one, and
  // every file's reviewed and demonstrated state is recomputed from it alone, so a file the latest attestation does not
  // cover is unreviewed and undemonstrated (see reviewedBy and demonstratedBy).
  applyAttest(sessionId, root, plan, createdAt) {
    const entry = this.session(sessionId, true)
    if (!entry.repos.has(root)) entry.repos.set(root, newRepo(root))
    const repo = entry.repos.get(root)
    for (const claim of plan.claims) repo.files.get(claim.absolute).claim = claim.decision
    for (const item of plan.items) repo.items.set(item.id, { state: item.state, reason: item.reason })
    repo.attestation = { digest: repositoryDigest(repo), summary: plan.summary ?? '', createdAt }
    for (const file of repo.files.values()) {
      file.reviewed = reviewedBy(plan, file)
      file.demonstrated = demonstratedBy(plan, file)
    }
    repo.stale = false
  }

  // Reopens every repository whose files no longer match the digest its attestation was bound to. A reopened repository has
  // every claim set back to unclaimed and every reviewed and demonstrated state cleared, its attestation dropped, and every item state
  // cleared except an unrelated mark: that mark is a statement about the session, not about the change set, so a later
  // change does not touch it. Returns the reopened roots, sorted. A repository with no attestation is never reopened here.
  reopenChanged(sessionId) {
    const entry = this.session(sessionId)
    if (!entry) return []
    const roots = []
    for (const repo of entry.repos.values()) {
      if (!repo.attestation || repo.attestation.digest === repositoryDigest(repo)) continue
      for (const file of repo.files.values()) { file.claim = 'unclaimed'; file.reviewed = false; file.demonstrated = null }
      for (const [id, item] of repo.items) if (item.state !== 'unrelated') repo.items.delete(id)
      repo.attestation = null
      repo.stale = true
      roots.push(repo.root)
    }
    return roots.sort()
  }

  // Whether this session holds an unrelated mark for a repository, which a reopen keeps (see reopenChanged). The advisory
  // notice asks this instead of reading the repository snapshot, so the fact comes from the tracker that stores it.
  hasUnrelatedMark(sessionId, root) {
    const repo = this.session(sessionId)?.repos.get(root)
    return Boolean(repo) && [...repo.items.values()].some(item => item.state === 'unrelated')
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
          return { path: file.path, absolute: file.absolute, claim: file.claim, reviewed: file.reviewed, demonstrated: file.demonstrated, key: file.key, documentation: isDocumentationPath(file.path) }
        }),
        itemStates: [...repo.items].map(([id, item]) => ({ id, state: item.state, reason: item.reason })),
        attestation: repo.attestation,
        introduced: repo.introduced,
        stale: repo.stale,
      }
    })
  }

  // Records that the session has been shown this repository's introduction, so a later message does not repeat it.
  markIntroduced(sessionId, root) {
    const repo = this.session(sessionId)?.repos.get(root)
    if (repo) repo.introduced = true
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
      attestation: repo.attestation ? { ...repo.attestation } : null,
      introduced: repo.introduced,
      stale: repo.stale,
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

// `introduced` is set once the session has been shown this repository's introduction (see markIntroduced). `stale` is set when
// a change after the attestation reopened the repository, and cleared by the next attestation.
function newRepo(root) { return { root, files: new Map(), items: new Map(), attestation: null, introduced: false, stale: false } }

// The digest an attestation is bound to: the sorted absolute paths of the repository's files, each with its content key. The
// claims, the reviewed states, and the item states are not part of it, so a claim, a review, or a catalog item can change
// without reopening the repository.
export function repositoryDigest(repo) {
  const hash = crypto.createHash('sha256')
  for (const absolute of [...repo.files.keys()].sort()) hash.update(`${absolute}\u0000${repo.files.get(absolute).key ?? ''}\n`)
  return hash.digest('hex')
}

// Whether one attestation covers a changed file's review: a documentation file is reviewed by a true documentation check,
// and a code file by its path in the reviewed list. Only the latest attestation is asked, so a file it does not cover is
// unreviewed (see applyAttest and reopenChanged).
function reviewedBy(plan, file) {
  return isDocumentationPath(file.path) ? plan.docsChecked === true : plan.reviewed.includes(file.absolute)
}

// What a demonstration entry must say when its note is empty. The refusal names the path, so the model knows which one.
export const DEMONSTRATION_PROBLEM = 'is demonstrated with no note. Say what you ran, where it ran, and what it showed.'

// Whether one attestation covers a changed file's demonstration. It covers a path listed with a note, and only for a file
// the same attestation covers as reviewed, because a demonstration of code nobody read is not evidence about the code a
// reviewer read. A rejected file keeps no state, because the obligation leaves with the claim (see evaluateRepository).
function demonstratedBy(plan, file) {
  return file.reviewed ? plan.demonstrated.get(file.absolute) ?? null : null
}

// A refused attest call. Nothing is stored when it is thrown. The message lists every error, so one call shows all of them.
export class AttestRefusal extends Error {
  constructor(errors) {
    super(`attest refused. Nothing was changed.\n${errors.map(error => `- ${error}`).join('\n')}`)
    this.name = 'AttestRefusal'
    this.errors = errors
  }
}

const ATTEST_KEYS = new Set(['action', 'repository_root', 'claims', 'reviewed_code_files', 'docs_checked', 'demonstrated_files', 'items', 'summary'])
const CLAIM_KEYS = new Set(['path', 'decision'])
const DEMONSTRATION_KEYS = new Set(['path', 'note'])
const ITEM_KEYS = new Set(['id', 'state', 'reason'])
const DECISIONS = new Set(['mine', 'not-mine'])
// A catalog item is passed in a run, assumed without one, or unrelated to this session. The unrelated mark is a statement
// about the session, not about the change set, so reopening keeps it (see reopenChanged). The tool schema reads this list,
// so the states a model may report and the states the handler accepts are one contract.
export const ITEM_STATES = new Set(['passed', 'assumed', 'unrelated'])
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
  const demonstrated = args.demonstrated_files === undefined ? [] : args.demonstrated_files
  if (!Array.isArray(demonstrated)) errors.push('demonstrated_files must be an array of {path, note} objects.')
  else {
    const seen = new Set()
    demonstrated.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`demonstrated_files[${index}] must be an object.`); return }
      for (const key of Object.keys(entry)) if (!DEMONSTRATION_KEYS.has(key)) errors.push(`demonstrated_files[${index}] has an unknown key: ${key}.`)
      if (!text(entry.path)) errors.push(`demonstrated_files[${index}].path is required.`)
      else if (seen.has(entry.path)) errors.push(`demonstrated_files[${index}].path repeats ${entry.path}.`)
      else seen.add(entry.path)
      if (entry.note !== undefined && typeof entry.note !== 'string') errors.push(`demonstrated_files[${index}].note must be a string.`)
    })
  }
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
      if (!ITEM_STATES.has(item.state)) errors.push(`items[${index}].state must be passed, assumed, or unrelated.`)
      if (item.reason !== undefined && typeof item.reason !== 'string') errors.push(`items[${index}].reason must be a string.`)
      if ((item.state === 'passed' || item.state === 'unrelated') && item.reason !== undefined) errors.push(`items[${index}] is ${item.state}, so it takes no reason.`)
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
  const demonstrated = (args.demonstrated_files ?? []).map(entry => {
    const absolute = absoluteFor(entry.path)
    if (!text(entry.note)) errors.push(`${entry.path} ${DEMONSTRATION_PROBLEM}`)
    return { absolute, note: text(entry.note) ? entry.note.trim() : '' }
  })
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
    demonstrated: new Map(demonstrated.map(entry => [entry.absolute, entry.note])),
    // An assumed item with no reason is unreported: it stays in the plan with no state, so applying it clears any earlier state.
    items: items.map(item => (item.state === 'assumed' && !text(item.reason)
      ? { id: item.id, state: null }
      : { id: item.id, state: item.state, ...(item.state === 'assumed' ? { reason: item.reason } : {}) })),
    summary: args.summary,
  }
}

// The obligations of one repository, from its snapshot (an entry of repositories) and its catalog as read from disk. Every
// problem is a sentence the report prints as it is. The repository is complete when no problem is left. A file's reviewed
// state is the one the tracker stored (see reviewedBy), so this reads state instead of deriving it again.
export function evaluateRepository(snapshot, catalogState) {
  const problems = []
  const attestation = snapshot.attestation
  const unclaimed = snapshot.files.filter(file => file.claim === 'unclaimed').map(file => file.absolute)
  if (unclaimed.length) problems.push(`Unclaimed changed files: ${unclaimed.join(', ')}. Claim each as yours, or reject it.`)
  const unreviewed = snapshot.files.filter(file => file.claim === 'mine' && !file.documentation && !file.reviewed).map(file => file.absolute)
  if (unreviewed.length) problems.push(`Claimed code files not reviewed: ${unreviewed.join(', ')}.`)
  const docsUnchecked = snapshot.files.filter(file => file.documentation && file.claim !== 'not-mine' && !file.reviewed).map(file => file.absolute)
  if (docsUnchecked.length) problems.push(`Changed documentation not checked: ${docsUnchecked.join(', ')}. Check each for staleness, bloat, and conflicting information, then attest with docs_checked true.`)
  const undemonstrated = snapshot.files.filter(file => file.claim === 'mine' && file.reviewed && !file.demonstrated).map(file => file.absolute)
  if (undemonstrated.length) problems.push(`Claimed files reviewed but not demonstrated: ${undemonstrated.join(', ')}. A review is only a reading, so run the change where it is used, then attest with demonstrated_files listing each path and what the run showed.`)
  if (catalogState.state === 'unreadable') problems.push(`The catalog cannot be read: ${catalogState.problem}.`)
  const stated = new Map(snapshot.itemStates.map(item => [item.id, item]))
  const items = catalogState.items.map(item => ({ id: item.id, name: item.name, state: stated.get(item.id)?.state ?? null, reason: stated.get(item.id)?.reason }))
  for (const item of items) if (!item.state) problems.push(`Catalog item not stated: ${item.id} (${item.name}).`)
  // A repository with no changed files and no catalog items has nothing to attest, so a missing attestation is no problem.
  if (!attestation && (snapshot.files.length || items.length)) problems.push('No current attestation for this repository.')
  // The same obligations as structured lists of absolute paths, for the advisory message. `problems` is the report's own text.
  return { ...snapshot, catalog: catalogState, items, unclaimed, unreviewed, docsUnchecked, undemonstrated, problems, complete: problems.length === 0 }
}
