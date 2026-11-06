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
    for (const file of repo.files) lines.push(`- ${file.absolute} (${file.claim})`)
  }
  return lines.join('\n')
}

// The catalog lines of one repository. An unreadable catalog is named with its problem and lists no items, because an
// empty list would read as a repository with nothing to verify.
function catalogLines(catalog) {
  if (catalog.state === 'absent') return ['No catalog exists yet. Register the verification items this repository needs with the register action.']
  if (catalog.state === 'unreadable') return [`Catalog unreadable, so its items are not listed: ${catalog.problem}. Register will not overwrite it.`]
  if (!catalog.items.length) return ['Catalog readable, with no items yet.']
  const count = catalog.items.length
  return [
    `Catalog readable, ${count} ${count === 1 ? 'item' : 'items'}:`,
    ...catalog.items.map(item => `- ${item.id}: ${item.name} | Proves: ${item.proves} | Command: ${item.command ?? 'none'}`),
  ]
}

// The result of the register action: where the catalog was written, which items it now holds, and whether git will ignore it.
export function registerMarkdown(result) {
  const lines = ['# Completion Gate register', '', `Catalog: ${result.path}`]
  for (const item of result.items) lines.push(`- ${item.id}: ${item.name} (${item.created ? 'registered' : 'updated'})`)
  lines.push(exclusionLine(result.exclusion))
  return lines.join('\n')
}

function exclusionLine(exclusion) {
  if (exclusion.applied && exclusion.added) return `Exclusion: .dsh/ was added to ${exclusion.file}, so git ignores the catalog.`
  if (exclusion.applied) return `Exclusion: .dsh/ was already listed in ${exclusion.file}, so git ignores the catalog.`
  return `Exclusion: not applied. Reason: ${exclusion.reason}.`
}
