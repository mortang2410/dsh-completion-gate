import fs from 'node:fs'
import path from 'node:path'

// The absolute path of one changed file. The host recorder reports each path relative to `base`, and an absolute
// path (a file-tool edit outside the working directory) is returned unchanged by path.resolve.
export function absoluteOf(base, file) {
  return path.resolve(String(base), String(file))
}

// A missing entry, or a parent that is not a directory, is absence. Any other failure (an I/O or permission error) is
// raised, because reading it as absence would file a changed file under the wrong repository.
function isAbsent(error) { return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' }

// A directory after symlinks are followed, so a symlinked repository root starts its own walk. A symlink that loops on
// itself is not a directory either, so its walk starts at its parent, as a file's does.
async function isDirectory(absolute) {
  try { return (await fs.promises.stat(absolute)).isDirectory() }
  catch (error) { if (isAbsent(error) || error?.code === 'ELOOP') return false; throw error }
}

async function hasGitEntry(dir) {
  try { await fs.promises.lstat(path.join(dir, '.git')); return true }
  catch (error) { if (isAbsent(error)) return false; throw error }
}

// The nearest ancestor of `absolute` that holds a `.git` entry, a directory or a file, or null when none does. The walk
// starts at the path itself when it is a directory, so a nested repository directory owns itself, and at its parent
// otherwise. It reads the file system only and starts no git process.
export async function gitRootOf(absolute) {
  const start = path.resolve(String(absolute))
  let dir = (await isDirectory(start)) ? start : path.dirname(start)
  for (;;) {
    if (await hasGitEntry(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// The repository that owns `absolute`. A path with no repository above it belongs to `fallback`, the session working
// directory.
export async function owningRoot(absolute, fallback) {
  return (await gitRootOf(absolute)) ?? path.resolve(String(fallback))
}
