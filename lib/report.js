// The Repositories section of the status action. It renders the repository report it is given and reads no file
// and runs no command, so status stays a read of state the gate already holds.
export function repositoriesMarkdown({ turn, notices = [], repositories = [] } = {}) {
  const lines = ['## Repositories', '']
  if (turn !== undefined && turn !== null) lines.push(`Turn: ${turn}`)
  for (const notice of notices) lines.push(`Notice: ${notice}`)
  if (!repositories.length) {
    lines.push('No changed file is attributed to a repository in this session yet.')
    return lines.join('\n')
  }
  for (const repo of repositories) {
    lines.push('', `### ${repo.label}`, `Root: ${repo.root}`, `Catalog: ${repo.catalogPath}`, ...catalogLines(repo.catalog))
    for (const file of repo.files) lines.push(`- ${file.absolute} (${file.claim}, ${stateText(file)})`)
    for (const item of repo.items) lines.push(`- ${item.id}: ${oneLine(item.name)} | ${itemStateText(item)}`)
    lines.push(`Attestation: ${repo.stale ? 'stale' : repo.attestation ? 'current' : 'missing'}`, `Status: ${repo.complete ? 'complete' : 'unfinished'}`, 'Problems:')
    if (repo.problems.length) for (const problem of repo.problems) lines.push(`- ${oneLine(problem)}`)
    else lines.push('- none')
  }
  return lines.join('\n')
}

// One changed file's two evidence states. A review is a reading; a demonstration is a run in which the change did what it
// claims, so "reviewed and demonstrated" is the strongest state a file reaches. A demonstrated file prints what the run
// showed, and a rejected file prints only its claim, because no obligation is left with it.
function stateText(file) {
  if (file.claim === 'not-mine') return 'rejected, so no review or demonstration is owed'
  if (file.reviewed && file.demonstrated) return `reviewed and demonstrated: ${oneLine(file.demonstrated)}`
  return file.reviewed ? 'reviewed, not demonstrated' : 'unreviewed'
}

// The state of one catalog item as the report prints it: passed, assumed with the reason the model gave, unrelated to this
// session, or not stated.
function itemStateText(item) {
  if (item.state === 'passed') return 'passed'
  if (item.state === 'assumed') return `assumed, not run: ${oneLine(item.reason)}`
  if (item.state === 'unrelated') return 'unrelated to this session'
  return 'not stated'
}

// One line of report text. A line break or other control character becomes a space, so the text cannot start a line of
// the report of its own. The catalog keeps its text as entered; only the report and the panel flatten it, and the panel
// imports this one function so the two always render a note the same way.
export function oneLine(text) { return String(text).replace(/[\u0000-\u001f\u007f]/g, ' ') }

// The catalog lines of one repository. An unreadable catalog is named with its problem and lists no items, because an
// empty list would read as a repository with nothing to verify.
function catalogLines(catalog) {
  if (catalog.state === 'absent') return ['No catalog exists yet. Register the verification items this repository needs with the register action.']
  if (catalog.state === 'unreadable') return [`Catalog unreadable, so its items are not listed: ${oneLine(catalog.problem)}. Register will not overwrite it.`]
  if (!catalog.items.length) return ['Catalog readable, with no items yet.']
  const count = catalog.items.length
  return [
    `Catalog readable, ${count} ${count === 1 ? 'item' : 'items'}:`,
    ...catalog.items.map(item => `- ${item.id}: ${oneLine(item.name)} | Proves: ${oneLine(item.proves)} | Command: ${oneLine(item.command ?? 'none')}`),
  ]
}

// The result of the register action: where the catalog was written, which items it now holds, and whether git will ignore it.
export function registerMarkdown(result) {
  const lines = ['# Completion Gate register', '', `Catalog: ${result.path}`]
  for (const item of result.items) lines.push(`- ${item.id}: ${oneLine(item.name)} (${item.created ? 'registered' : 'updated'})`)
  lines.push(exclusionLine(result.exclusion))
  return lines.join('\n')
}

function exclusionLine(exclusion) {
  if (exclusion.applied && exclusion.added) return `Exclusion: .dsh/ was added to ${exclusion.file}, so git ignores the catalog.`
  if (exclusion.applied) return `Exclusion: .dsh/ was already listed in ${exclusion.file}, so git ignores the catalog.`
  return `Exclusion: not applied. Reason: ${exclusion.reason}.`
}

// The advisory message of a stop: one text for everything the session still has open. It says nothing is stopped and that
// no project verification check ran, and it never uses blocking wording or claims a check failed. It returns null when there
// is nothing to say. `undetermined` is the reason the change set could not be read, if it could not. `notices` are plain
// facts the gate could not check at this stop. `repositories` are the open repositories, which the caller selects (see
// evaluateRepository), and each one is listed. `credentials` are scanSecurity hits, of which only the rule message is
// written, never the matched text. `diffGaps` lists the changed files whose added lines were not read.
export function advisoryMessage({ undetermined = null, notices = [], repositories = [], credentials = [], diffGaps = [] } = {}) {
  const credentialLines = credentialSection(credentials, diffGaps)
  if (!undetermined && !notices.length && !repositories.length && !credentialLines.length) return null
  const parts = ['Completion Gate advisory. Nothing is stopped, and no project verification check ran.']
  if (undetermined) parts.push(`${oneLine(undetermined)} Check which files you changed yourself, then attest each repository you changed.`)
  if (notices.length) parts.push(notices.map(notice => oneLine(notice)).join('\n'))
  for (const repo of repositories) parts.push(repositorySection(repo))
  if (credentialLines.length) parts.push(credentialLines.join('\n'))
  return parts.join('\n\n')
}

function repositorySection(repo) {
  const lines = [`Repository: ${oneLine(repo.label)}`, `Root: ${oneLine(repo.root)}`]
  if (!repo.introduced) lines.push(introLine(repo))
  const claimed = repo.files.filter(file => file.claim === 'mine').map(file => file.absolute)
  const rejected = repo.files.filter(file => file.claim === 'not-mine').map(file => file.absolute)
  lines.push(...listLines('Changed files not claimed yet (claim each as yours, or reject it):', repo.unclaimed))
  lines.push(...listLines('Claimed as yours:', claimed))
  lines.push(...listLines('Rejected as not yours:', rejected))
  lines.push(...listLines('Changed code not reviewed yet:', repo.unreviewed))
  lines.push(...listLines('Changed documentation not checked yet:', repo.docsUnchecked))
  lines.push(...listLines('Reviewed as a reading but not demonstrated yet (a review is not a run; show the change working in the place it serves):', repo.undemonstrated))
  if (repo.catalog.state === 'unreadable') lines.push(`Catalog unreadable, so its items cannot be checked: ${oneLine(repo.catalog.problem)}. Register will not overwrite it.`)
  // An item marked unrelated to this session is left out entirely: the mark says the item does not bear on this work, so
  // listing it would ask again for what the session already silenced. It is still listed by the status report.
  const items = repo.items.filter(item => item.state !== 'unrelated')
  if (items.length) lines.push('Verification items:', ...items.map(item => `- ${oneLine(item.name)} (${oneLine(item.id)}): ${advisoryItemText(item)}`))
  lines.push(attestationLine(repo), nextLine(repo))
  return lines.join('\n')
}

// The introduction, shown until the message that carries it is delivered. It is not repeated after that. An unreadable
// catalog is not offered for reading or registration, because registration refuses it until it is repaired.
function introLine(repo) {
  if (repo.catalog.state === 'unreadable') return `This repository is new to this session. Its verification catalog at ${oneLine(repo.catalogPath)} cannot be read. Repair it so it reads again, and do not register items until then.`
  return `This repository is new to this session. Its verification catalog is at ${oneLine(repo.catalogPath)}. Read it, adopt the items that fit this work by attesting to them, and register the items you will run. Each item says what passing it proves.`
}

// One heading and every one of its paths. Nothing is listed under a heading with no path.
function listLines(heading, paths) {
  if (!paths.length) return []
  return [heading, ...paths.map(item => `- ${oneLine(item)}`)]
}

// An item's state as the advisory states it. An assumed item is a promise with its reason, never a pass or a run. An item
// marked unrelated never reaches this line, because repositorySection leaves it out of the list.
function advisoryItemText(item) {
  if (item.state === 'passed') return 'passed'
  if (item.state === 'assumed') return `assumed, not run. This is a promise, not a pass. Reason: ${oneLine(item.reason ?? '')}`
  return 'unfinished, no state reported yet'
}

function attestationLine(repo) {
  if (repo.attestation) return 'Attestation: current.'
  if (repo.stale) return 'Attestation: stale (files changed after the last attestation, so it was dropped).'
  return 'Attestation: missing.'
}

// The one call to action of a repository, once per repository block. An unreadable catalog is repaired first, because
// registration refuses it.
function nextLine(repo) {
  const first = repo.catalog.state === 'unreadable'
    ? `repair the verification catalog at ${oneLine(repo.catalogPath)} so it reads again, then register`
    : 'register'
  return `Next: ${first} the verification you will run, run it yourself, claim or reject each changed file, review each changed code file you claim, check each changed document you did not reject, demonstrate the change in real use, then honestly attest by calling completion_gate with action=attest, demonstrated_files naming each path with the command it ran and that command's output, and repository_root set to ${oneLine(repo.root)}.`
}

// The credential hits of this turn's added lines, grouped by rule with a count per rule. The matched text is not written.
// An unread file gets its own line whether or not a hit exists, because the scan may then be incomplete.
function credentialSection(credentials, diffGaps) {
  const lines = []
  if (credentials.length) {
    const byRule = new Map()
    for (const hit of credentials) byRule.set(hit.message, (byRule.get(hit.message) ?? 0) + 1)
    lines.push('Possible credentials in this turn\'s added lines, by rule (the matched text is not shown):')
    for (const [message, count] of byRule) lines.push(`- ${oneLine(message)}: ${count} ${count === 1 ? 'line' : 'lines'}`)
  }
  if (diffGaps.length) {
    lines.push(`${diffGaps.length} changed ${diffGaps.length === 1 ? 'file' : 'files'} could not be read for this scan, so the scan may be incomplete.`)
    // A gap names the file by its path, so the file can be had checked; an older gap carries only its one-line text.
    for (const gap of diffGaps) lines.push(`- ${oneLine(gap.path === undefined ? gap.text ?? String(gap) : `${gap.path}: ${gap.reason}`)}`)
  }
  return lines
}
