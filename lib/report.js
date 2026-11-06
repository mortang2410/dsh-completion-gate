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
    lines.push('', `### ${repo.label}`, `Root: ${repo.root}`, `Catalog: ${repo.catalogPath}`)
    for (const file of repo.files) lines.push(`- ${file.absolute} (${file.claim})`)
  }
  return lines.join('\n')
}
