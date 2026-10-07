import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanText, detectChecks, redactText } from './core.js'
import { isVerifyingRecipe, loadManifest, resolveRecipe } from './recipe.js'

// One module decides which verification sources are available, so the stop hook, the runner and
// the tool handler cannot disagree. The precedence mirrors the spec: canonical checks keep
// authority and are never replaced by a recipe or a probe; a configured but unusable verifier
// blocks rather than silently making the easier fallback eligible.

export const VERIFICATION_SOURCES = Object.freeze(['canonical', 'external', 'recipe', 'temporary', 'none'])

// This plugin integrates no external verification provider, so the external slot is always
// empty. It is reported rather than omitted so the control center can state that plainly. The
// plugin's own "configured but unavailable" case is a saved recipe manifest that exists but
// cannot be used, handled below: that is operator intent the fallback must not silently bypass.
const NO_EXTERNAL_VERIFIER = Object.freeze({ configured: false, usable: false, name: '' })

export function verificationInventory({ cwd, config, ledger, sessionId, fingerprint, documentationOnly = false }) {
  const checks = documentationOnly ? [] : detectChecks(cwd, config)
  const canonical = checks.filter(check => check.category === 'test' || check.required)
  const external = NO_EXTERNAL_VERIFIER
  const resolved = resolveRecipe(cwd, config)
  const recipeUsable = Boolean(resolved.recipe && isVerifyingRecipe(resolved.recipe))
  const saved = loadManifest(cwd)
  // A saved manifest that is present but unusable is a deliberate contract the operator set and
  // that cannot be honoured, so the easier ad-hoc probe must not stand in for it.
  const savedUnusable = saved.problem !== null
  const recorded = ledger && fingerprint !== undefined ? ledger.summary(sessionId, fingerprint) : { satisfied: false, fresh: 0, total: 0 }

  // A documentation-only turn has no behavioral requirement at all, so no source is offered and
  // none is needed: the added-line scans and the attestation still apply on their own.
  const eligibleForTemporary = Boolean(
    config.allowTemporaryVerifier
    && !documentationOnly
    && canonical.length === 0
    && !recipeUsable
    && !savedUnusable,
  )
  let temporaryReason = null
  if (!eligibleForTemporary && !documentationOnly) {
    if (!config.allowTemporaryVerifier) temporaryReason = 'the temporary verifier is disabled by configuration'
    else if (savedUnusable) temporaryReason = `a verifier is configured but unavailable (${resolved.problems[0]}), so the fallback is refused`
    else if (canonical.length) temporaryReason = 'a canonical check exists, so the fallback is not needed'
    else if (recipeUsable) temporaryReason = 'a usable recipe exists, so the fallback is not needed'
  }

  let selected = 'none'
  if (documentationOnly) selected = 'none'
  else if (canonical.length) selected = 'canonical'
  else if (recipeUsable) selected = 'recipe'
  else if (eligibleForTemporary) selected = 'temporary'

  return {
    canonical: { checks: canonical, exists: canonical.length > 0 },
    external,
    savedRecipe: saved.recipe,
    recipe: { recipe: resolved.recipe, source: resolved.source, usable: recipeUsable, problems: resolved.problems },
    temporary: { eligible: eligibleForTemporary, reason: temporaryReason },
    documentationOnly,
    recorded: { satisfied: Boolean(recorded.satisfied), fresh: recorded.fresh, total: recorded.total },
    selected,
    satisfied: documentationOnly || Boolean(recorded.satisfied) || (selected === 'canonical' && canonical.length === 0),
  }
}

// Human-readable steering derived from the single decision above.
export function verificationGuidance(inventory) {
  if (inventory.documentationOnly) return null
  if (inventory.recorded.satisfied) return null
  if (inventory.recipe.problems.length && !inventory.recipe.usable) return `Fix the saved recipe, which cannot be used: ${inventory.recipe.problems[0]}`
  if (inventory.selected === 'recipe') return `Run the detected recipe "${inventory.recipe.recipe.name}" with completion_gate action=recipe, then attest.`
  if (inventory.selected === 'temporary') return 'No canonical check and no usable recipe were found. Write a small temporary script under the system temporary directory and run it with completion_gate action=temporary_verify.'
  return null
}

// ---------------------------------------------------------------------------
// Temporary verifier (last resort). Validated strictly, then executed directly.
// ---------------------------------------------------------------------------

export const TEMPORARY_RUNTIMES = Object.freeze(['node', 'python3', 'python', 'bash', 'sh', 'ruby', 'perl'])
export const TEMPORARY_PREFIX = 'dsh-verify-'
const TEMPORARY_MAX_BYTES = 256 * 1024

function temporaryRoots() {
  const roots = new Set(['/tmp', path.resolve(os.tmpdir())])
  return [...roots]
}

function inside(dir, target) {
  if (dir === null) return false
  return target === dir || target.startsWith(dir + path.sep)
}

export function validateTemporaryScript({ scriptPath, cwd, runtime, sizeCap = TEMPORARY_MAX_BYTES }) {
  if (typeof scriptPath !== 'string' || !scriptPath.trim()) return { ok: false, reason: 'A script path is required.' }
  if (!path.isAbsolute(scriptPath)) return { ok: false, reason: 'The script path must be absolute.' }
  const roots = temporaryRoots()
  const lexical = path.resolve(scriptPath)
  if (!roots.some(temp => inside(temp, lexical))) {
    return { ok: false, reason: `The script must resolve under the system temporary directory (${roots.join(' or ')}).` }
  }
  if (!path.basename(lexical).startsWith(TEMPORARY_PREFIX)) return { ok: false, reason: `The script name must start with "${TEMPORARY_PREFIX}".` }
  if (!TEMPORARY_RUNTIMES.includes(runtime)) return { ok: false, reason: `Runtime must be one of: ${TEMPORARY_RUNTIMES.join(', ')}.` }
  let stat
  try { stat = fs.statSync(lexical) }
  catch { return { ok: false, reason: 'The script does not exist.' } }
  if (!stat.isFile()) return { ok: false, reason: 'The script must be a regular file.' }
  if (stat.size > sizeCap) return { ok: false, reason: `The script is ${stat.size} bytes, over the ${sizeCap}-byte cap.` }
  // The repository is compared through realpath as well, so a symlink placed in the temporary
  // directory that points back into the project cannot smuggle project code past this check.
  const root = realDir(cwd)
  const target = realDir(lexical)
  if (target === null) return { ok: false, reason: 'The script does not exist.' }
  if (inside(root, target)) return { ok: false, reason: 'The script must lie outside the project repository.' }
  return { ok: true, resolved: lexical, runtime, size: stat.size }
}

function realDir(target) {
  try { return fs.realpathSync(target) } catch { return null }
}

// A fingerprint of the project's files, used to prove a probe did not edit the code it is testing.
// Per regular file it hashes the path, size, permission bits, modification time and CONTENT.
// Content is the part a metadata-only comparison misses: a script can write different bytes of the
// same length and restore the exact nanosecond modification time (`os.utime(ns=...)` in Python does
// this), leaving size and mtime identical. Mode and mtime are kept as well, because they catch what
// content alone cannot: flipping an executable bit, or writing different bytes and then restoring
// the original ones, both leave every file's final content identical to its starting content.
// Symlinks contribute their target, since retargeting one changes what the project resolves without
// changing any file's contents. This deliberately does not use git: the temporary verifier exists
// for projects with no harness at all, and those are frequently not repositories.
//
// Ceilings, stated rather than hidden:
//   - Files under a skipped directory are not fingerprinted. Dependencies (node_modules), virtual
//     environments and VCS internals are not the code under test, and walking them would exceed the
//     file cap on nearly every Node project. A probe that edits only those is not detected.
//   - Only the project root is covered, so a write outside it is not detected.
//   - The probe's own process group is killed before the comparison, but a child that creates its
//     own process group or session escapes that signal and can still write afterwards.
//   - A script can in principle restore content, mode, mtime and link targets exactly, which would
//     defeat the comparison; that is beyond what a before-and-after snapshot can prove.
const FINGERPRINT_SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__'])
const FINGERPRINT_MAX_FILES = 5000
const FINGERPRINT_MAX_TOTAL_BYTES = 64 * 1024 * 1024

// The walk becomes incomplete whenever it cannot see everything, because a partial listing cannot
// prove a file it missed was left alone. The caller then refuses the run instead of reporting a
// pass. That happens when:
//   - a bound is hit (entry count or total bytes);
//   - a file cannot be read, for example one the probe set to mode 000;
//   - a directory cannot be listed, for example one the probe left search-only. A file inside such
//     a directory is still writable by path, so skipping the directory would hide the edit;
//   - an entry is neither a regular file, a directory nor a symlink (a FIFO or socket, say), since
//     the comparison has no way to describe it.
function workspaceFingerprint(cwd) {
  const hash = crypto.createHash('sha256')
  let entries = 0
  let bytes = 0
  let incomplete = null
  // One entry of any kind counts against the cap, so a workspace of symlinks cannot slip past it.
  const count = () => {
    if (entries >= FINGERPRINT_MAX_FILES) { incomplete = `it holds more than ${FINGERPRINT_MAX_FILES} entries`; return false }
    entries += 1
    return true
  }
  const walk = dir => {
    if (incomplete) return
    let children
    try { children = fs.readdirSync(dir, { withFileTypes: true }) }
    catch { incomplete = `a directory could not be listed (${path.relative(cwd, dir) || '.'})`; return }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (incomplete) return
      const full = path.join(dir, child.name)
      const rel = path.relative(cwd, full)
      // The skip rule applies only to a real directory's CONTENTS. A symlink named `node_modules`
      // is fingerprinted like any other symlink, so retargeting it cannot hide behind the name.
      if (child.isDirectory() && FINGERPRINT_SKIP.has(child.name)) continue
      if (child.isSymbolicLink()) {
        // A retargeted symlink changes what the project resolves without changing any file's
        // contents, so the link target itself is part of the fingerprint.
        let target
        try { target = fs.readlinkSync(full) }
        catch { incomplete = `a symlink could not be read (${rel})`; return }
        if (!count()) return
        hash.update(`${rel}\u0000link\u0000${target}\u0001`)
        continue
      }
      if (child.isDirectory()) {
        if (!count()) return
        // Directories are recorded too, so creating or removing an empty one is visible.
        let stat
        try { stat = fs.statSync(full) }
        catch { incomplete = `a directory could not be read (${rel})`; return }
        hash.update(`${rel}\u0000dir\u0000${(stat.mode & 0o777).toString(8)}\u0001`)
        walk(full)
        continue
      }
      if (!child.isFile()) { incomplete = `it holds an entry that is neither a file, a directory nor a symlink (${rel})`; return }
      let content, stat
      try { content = fs.readFileSync(full); stat = fs.statSync(full) }
      catch { incomplete = `a file could not be read (${rel})`; return }
      bytes += content.length
      if (bytes > FINGERPRINT_MAX_TOTAL_BYTES) { incomplete = `it holds more than ${FINGERPRINT_MAX_TOTAL_BYTES} bytes`; return }
      if (!count()) return
      // Content is what a metadata-only comparison misses, so it is hashed. The mode and
      // modification time are hashed as well, because they catch the cases content alone cannot:
      // flipping an executable bit, and writing different bytes then restoring the original ones,
      // both of which leave every file's final CONTENT identical to its starting content.
      hash.update(`${rel}\u0000${content.length}\u0000${(stat.mode & 0o777).toString(8)}\u0000${stat.mtimeMs}\u0000`)
      hash.update(content)
      hash.update('\u0001')
    }
  }
  walk(cwd)
  if (incomplete) return { incomplete }
  return { digest: hash.digest('hex') }
}

// Signals the probe's whole process group, so a detached descendant cannot keep editing the
// workspace after the probe itself exits. Windows has no process groups, so only the direct child
// is signalled there.
function killGroup(child, signal) {
  if (child.pid == null) return
  if (process.platform === 'win32') { try { child.kill(signal) } catch {} ; return }
  try { process.kill(-child.pid, signal) }
  catch (error) { if (error?.code !== 'ESRCH') try { child.kill(signal) } catch {} }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const TERMINATE_SETTLE_MS = 150

// The script is executed DIRECTLY, with an argv array and no shell string, so an appended
// `|| true` cannot mask a failure: there is no shell to interpret it.
export function runTemporaryScript(validation, cwd, args = [], config = {}) {
  return new Promise(resolve => {
    const before = workspaceFingerprint(cwd)
    if (before.incomplete !== undefined) {
      resolve({
        pass: false, exitCode: null, output: '',
        detail: `The workspace cannot be compared before and after the run: ${before.incomplete}. The probe therefore cannot be checked for repository edits.`,
        mutatedRepository: false,
      })
      return
    }
    const spawned = spawn(validation.runtime, [validation.resolved, ...(Array.isArray(args) ? args.map(String) : [])], {
      cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    })
    let output = ''
    const collect = chunk => { output += chunk; if (output.length > 40_000) output = output.slice(-40_000) }
    spawned.stdout?.on('data', collect)
    spawned.stderr?.on('data', collect)
    const timer = setTimeout(() => { killGroup(spawned, 'SIGKILL') }, config.commandTimeoutMs ?? 600_000)
    const finish = async (code, error) => {
      clearTimeout(timer)
      // The probe's whole group is torn down BEFORE the comparison, so a descendant the probe
      // backgrounded (a server, a watcher, a job) cannot keep writing while the tree is
      // fingerprinted. A child that creates its OWN process group or session is out of reach of
      // this signal; that case is the stated ceiling on this function.
      killGroup(spawned, 'SIGKILL')
      // A short settle window, so a just-killed descendant's last write lands before the walk.
      await sleep(TERMINATE_SETTLE_MS)
      const after = workspaceFingerprint(cwd)
      // An incomplete comparison is not proof of a clean tree, so the run is refused.
      const unverifiable = after.incomplete !== undefined
      const mutated = !unverifiable && after.digest !== before.digest
      resolve({
        pass: code === 0 && !error && !mutated && !unverifiable,
        exitCode: code,
        output: redactText(output, cwd, config.maxOutputChars ?? 12_000),
        detail: error
          || (mutated ? 'The script changed repository state, so it was rejected.' : '')
          || (unverifiable ? `The workspace could not be compared after the run: ${after.incomplete}. The probe therefore cannot be checked for repository edits.` : ''),
        mutatedRepository: mutated,
      })
    }
    spawned.on('error', error => { void finish(null, cleanText(error?.message || error, 300)) })
    spawned.on('close', code => { void finish(code, null) })
  })
}
