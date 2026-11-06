import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitRootOf } from './repositories.js'

const execFileP = promisify(execFile)

// The verification catalog of one repository: the items a session commits to run, each with a comment on what passing it
// proves. The file is knowledge for the next session to read. Nothing in this module runs an item's command.
export const CATALOG_VERSION = 1
const DIRECTORY = '.dsh'
const EXCLUDE_LINE = '.dsh/'
const BOUNDS = { name: 120, proves: 1000, command: 1000 }
const SLUG_MAX = 60
const GIT_TIMEOUT_MS = 5000

// A refusal or a catalog problem. The message names what was wrong, so the caller can show it as it is.
export class CatalogError extends Error {}

export function catalogPathOf(root) { return path.join(root, DIRECTORY, 'verification.json') }

// Reads the catalog of one repository and never throws. A missing file is "absent". A file that cannot be read or parsed is
// "unreadable" and carries its problem. Callers show the problem and never treat an unreadable catalog as an empty one.
export function readCatalog(root) {
  const file = catalogPathOf(root)
  let text
  try { text = fs.readFileSync(file, 'utf8') }
  catch (error) {
    if (error?.code === 'ENOENT') return { path: file, state: 'absent', items: [], problem: null }
    return { path: file, state: 'unreadable', items: [], problem: `the file cannot be read: ${error?.message || error}` }
  }
  try { return { path: file, state: 'readable', items: parseCatalog(text).items, problem: null } }
  catch (error) { return { path: file, state: 'unreadable', items: [], problem: error.message } }
}

function parseCatalog(text) {
  let data
  try { data = JSON.parse(text) }
  catch (error) { throw new CatalogError(`the file is not valid JSON: ${error.message}`) }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CatalogError('the top level is not an object')
  if (data.version !== CATALOG_VERSION) throw new CatalogError(`the version is ${JSON.stringify(data.version)}, and this plugin reads version ${CATALOG_VERSION}`)
  if (!Array.isArray(data.items)) throw new CatalogError('items is not an array')
  data.items.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new CatalogError(`items[${index}] is not an object`)
    for (const key of ['id', 'name', 'proves', 'addedAt', 'updatedAt']) {
      if (typeof item[key] !== 'string' || !item[key].trim()) throw new CatalogError(`items[${index}].${key} is missing or empty`)
    }
    if (item.command !== undefined && typeof item.command !== 'string') throw new CatalogError(`items[${index}].command is not a string`)
  })
  return data
}

// Trims one text field and refuses it when it is required and empty, or longer than its bound. Control characters become
// spaces, so one item stays on one line of the status report. Text past its bound is refused, never cut.
function textField(value, label, bound, required) {
  if (value === undefined || value === null) {
    if (required) throw new CatalogError(`${label} is required.`)
    return undefined
  }
  if (typeof value !== 'string') throw new CatalogError(`${label} must be a string.`)
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (!text) {
    if (required) throw new CatalogError(`${label} is required, and it is empty.`)
    return undefined
  }
  if (text.length > bound) throw new CatalogError(`${label} is ${text.length} characters, over the limit of ${bound} characters.`)
  return text
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new CatalogError('items must be a non-empty array of objects with name, proves, and an optional command.')
  return items.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CatalogError(`items[${index}] must be an object.`)
    return {
      name: textField(input.name, `items[${index}].name`, BOUNDS.name, true),
      proves: textField(input.proves, `items[${index}].proves`, BOUNDS.proves, true),
      command: textField(input.command, `items[${index}].command`, BOUNDS.command, false),
    }
  })
}

// The id of a new item: the lowercase name with each run of non-alphanumeric characters as one dash, at most SLUG_MAX
// characters. A name with no ASCII letter or digit gets the id "item".
export function slugOf(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.slice(0, SLUG_MAX).replace(/-+$/, '') || 'item'
}

// The base id with a numeric suffix when the base is taken, so two names that share a slug still get distinct ids.
function uniqueId(base, taken) {
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

// Writes items into the catalog of one repository root and returns what was written. Input is checked and an unreadable
// catalog is refused before anything is written. The `.dsh/` exclude line is added before the catalog is written, so a
// catalog that exists is never missing its exclude line.
export async function registerItems(root, items) {
  const incoming = normalizeItems(items)
  const file = catalogPathOf(root)
  const current = readCatalog(root)
  if (current.state === 'unreadable') throw new CatalogError(`${file} cannot be used, so register will not overwrite it: ${current.problem}.`)
  const stamp = new Date().toISOString()
  const next = current.items.map(item => ({ ...item }))
  const taken = new Set(next.map(item => item.id))
  const written = []
  for (const input of incoming) {
    const existing = next.find(item => item.name === input.name)
    if (existing) {
      existing.proves = input.proves
      if (input.command === undefined) delete existing.command
      else existing.command = input.command
      existing.updatedAt = stamp
      written.push({ id: existing.id, name: existing.name, created: false })
      continue
    }
    const id = uniqueId(slugOf(input.name), taken)
    taken.add(id)
    next.push({ id, name: input.name, proves: input.proves, ...(input.command === undefined ? {} : { command: input.command }), addedAt: stamp, updatedAt: stamp })
    written.push({ id, name: input.name, created: true })
  }
  const exclusion = await excludeCatalog(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeAtomically(file, `${JSON.stringify({ version: CATALOG_VERSION, items: next }, null, 2)}\n`)
  return { path: file, items: written, exclusion }
}

// Adds the `.dsh/` line to the repository's local exclude file, once. That file is git's per-clone ignore list, so the
// tracked .gitignore is never edited. A root that is not a git repository gets no line and no error. A root whose git
// repository is some other directory gets no line either, so the line never lands in a parent repository's exclude file.
export async function excludeCatalog(root) {
  if ((await gitRootOf(root)) !== root) return { applied: false, reason: 'the root is not a git repository' }
  let toplevel, excludeFile
  try {
    const { stdout } = await execFileP('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-path', 'info/exclude'], { timeout: GIT_TIMEOUT_MS, maxBuffer: 4096, windowsHide: true })
    const lines = stdout.split('\n')
    toplevel = lines[0]
    excludeFile = lines[1]
  } catch (error) {
    return { applied: false, reason: `git could not resolve the exclude file: ${String(error?.stderr || error?.message || error).trim()}` }
  }
  if (!toplevel || !excludeFile || fs.realpathSync(toplevel) !== fs.realpathSync(root)) {
    return { applied: false, reason: `git resolves the repository at ${toplevel || 'an unknown path'}, not this root` }
  }
  let text = ''
  try { text = fs.readFileSync(excludeFile, 'utf8') }
  catch (error) { if (error?.code !== 'ENOENT') return { applied: false, reason: `the exclude file cannot be read: ${error.message}` } }
  if (text.split(/\r?\n/).includes(EXCLUDE_LINE)) return { applied: true, added: false, file: excludeFile }
  fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
  fs.appendFileSync(excludeFile, `${text && !text.endsWith('\n') ? '\n' : ''}${EXCLUDE_LINE}\n`)
  return { applied: true, added: true, file: excludeFile }
}

// Writes a temporary file beside the catalog, then renames it over the catalog, so a failed write never leaves a part-written
// catalog behind.
function writeAtomically(file, text) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temp, text, { flag: 'wx' })
  try { fs.renameSync(temp, file) }
  catch (error) {
    try { fs.unlinkSync(temp) } catch {}
    throw error
  }
}
