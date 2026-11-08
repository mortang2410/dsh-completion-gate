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

// A path that cannot be followed to an entry: an absent one, or a symlink that loops on itself. Resolving the path keeps
// its name for it, and the directory check counts it as no directory.
function isUnfollowable(error) { return isAbsent(error) || error?.code === 'ELOOP' }

// The real path of `absolute`, with every symlink in it followed, so a path through a link names the place its bytes
// live. A component that does not exist (a deleted file or directory) keeps its name, and the real path of its deepest
// existing ancestor stands for the rest. A symlink that loops on itself has no real path, so it keeps its own name too.
// It is exported for the seen-root check, which credits a symlinked path to the repository that path resolves into.
export async function realPathOf(absolute) {
  const missing = []
  let current = absolute
  for (;;) {
    try { return path.join(await fs.promises.realpath(current), ...missing) }
    catch (error) {
      const parent = path.dirname(current)
      if (parent === current || !isUnfollowable(error)) throw error
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

// A directory, after the path has been resolved. A symlink left in it loops on itself or dangles, and neither is a
// directory, so its walk starts at its parent, as a file's does.
async function isDirectory(absolute) {
  try { return (await fs.promises.stat(absolute)).isDirectory() }
  catch (error) { if (isUnfollowable(error)) return false; throw error }
}

async function hasGitEntry(dir) {
  try { await fs.promises.lstat(path.join(dir, '.git')); return true }
  catch (error) { if (isAbsent(error)) return false; throw error }
}

// The nearest ancestor of `absolute` that holds a `.git` entry, a directory or a file, or null when none does. The path is
// resolved first, so a symlink in it leads to the repository that holds its target, as git's own top-level lookup does for
// a path through a symlinked directory. The walk starts at the path itself when it is a directory, so a nested repository
// directory owns itself, and at its parent otherwise. It reads the file system only and starts no git process.
export async function gitRootOf(absolute) {
  const start = await realPathOf(path.resolve(String(absolute)))
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
