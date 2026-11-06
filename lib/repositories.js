import fs from 'node:fs'
import path from 'node:path'

// The absolute path of one changed file. The host recorder reports each path relative to `base`, and an absolute
// path (a file-tool edit outside the working directory) is returned unchanged by path.resolve.
export function absoluteOf(base, file) {
  return path.resolve(String(base), String(file))
}

async function isDirectory(absolute) {
  try { return (await fs.promises.lstat(absolute)).isDirectory() }
  catch { return false }
}

async function hasGitEntry(dir) {
  try { await fs.promises.lstat(path.join(dir, '.git')); return true }
  catch { return false }
}

// The repository that owns `absolute`: the nearest ancestor holding a `.git` entry, a directory or a file. The walk
// starts at the path itself when it is a directory, so a nested repository directory owns itself, and at its parent
// otherwise. It reads the file system only and starts no git process. A path with no such ancestor belongs to
// `fallback`, the session working directory.
export async function owningRoot(absolute, fallback) {
  const start = path.resolve(String(absolute))
  let dir = (await isDirectory(start)) ? start : path.dirname(start)
  for (;;) {
    if (await hasGitEntry(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(String(fallback))
}
