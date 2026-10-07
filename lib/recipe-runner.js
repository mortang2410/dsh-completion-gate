import { spawn } from 'node:child_process'
import http from 'node:http'
import { DEFAULT_CONFIG, cleanText, redactText } from './core.js'
import { RECIPE_DEFAULT_OPTIONS, RECIPE_PHASES, normalizeRecipe } from './recipe.js'

// Recipe execution, ported from the Hermes verify runner (agent/verify/runner.py):
// bootstrap, build and test run in order and stop at the first failure, then the start
// command is booted in its own process group, the readiness URL is polled, and the whole
// group is terminated on success and on failure. Nothing here starts by itself; the gate
// calls runRecipe only when the agent asks for a run.

const READINESS_POLL_INTERVAL_MS = 100
const PROBE_TIMEOUT_MS = 2000
const TERMINATE_GRACE_MS = 300
const COMPOSE_PROBE_TIMEOUT_MS = 15_000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const exited = child => child.exitCode !== null || child.signalCode !== null

function waitExit(child, ms) {
  return new Promise(resolve => {
    if (exited(child)) return resolve(true)
    const timer = setTimeout(() => { child.off('close', onClose); resolve(false) }, ms)
    const onClose = () => { clearTimeout(timer); resolve(true) }
    child.on('close', onClose)
  })
}

// Every command leads its own process group. `sh` forks rather than execs a simple
// command on this platform, so signalling only the shell would leave the real command
// running and hold the output pipes open past the timeout.
function spawnShell(command, cwd, env) {
  return spawn(command, [], { cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh' })
}

function collect(stream, sink) { stream?.on('data', chunk => sink(chunk)) }

// Bounded output collection: keep the tail, which is where a failing command explains
// itself. redactText keeps the first 2*max characters it is given, so the collector hands it
// a tail of exactly 2*max to preserve the genuine last max characters of the output.
function tailCollector(max) {
  const limit = max * 2
  let text = ''
  return { add: chunk => { text += chunk; if (text.length > limit) text = text.slice(-limit) }, get: () => text }
}

function runPhaseCommand(phase, command, cwd, settings, signal) {
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawnShell(command, cwd, settings.env)
    const collector = tailCollector(settings.maxOutputChars)
    collect(child.stdout, collector.add)
    collect(child.stderr, collector.add)
    let timedOut = false, aborted = false, spawnError = null
    const timer = setTimeout(() => { timedOut = true; void terminateGroup(child) }, settings.commandTimeoutMs)
    const onAbort = () => { aborted = true; void terminateGroup(child) }
    signal?.addEventListener('abort', onAbort, { once: true })
    const finish = exitCode => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        phase, command, exitCode, timedOut, aborted, ok: !timedOut && !aborted && !spawnError && exitCode === 0,
        durationMs: Date.now() - started, error: spawnError, output: redactText(collector.get(), cwd, settings.maxOutputChars),
      })
    }
    child.on('error', error => { spawnError = cleanText(error?.message || error, 200) })
    child.on('close', code => finish(code))
  })
}

function httpProbe(url, timeoutMs) {
  return new Promise(resolve => {
    const request = http.get(url, response => { response.resume(); resolve({ statusCode: response.statusCode, error: null }) })
    request.setTimeout(timeoutMs, () => request.destroy(new Error('no response')))
    request.on('error', error => resolve({ statusCode: null, error: cleanText(error?.message || error, 200) }))
  })
}

// Any HTTP answer means the process booted, including 404 and 500; only a request that
// never completes counts as not ready.
async function pollReadiness(url, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  let error = null
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ready: false, statusCode: null, error: 'aborted' }
    const attempt = await httpProbe(url, Math.min(PROBE_TIMEOUT_MS, Math.max(deadline - Date.now(), 1)))
    if (attempt.statusCode !== null) return { ready: true, statusCode: attempt.statusCode, error: null }
    error = attempt.error
    await sleep(Math.min(READINESS_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 0)))
  }
  return { ready: false, statusCode: null, error: error || `no HTTP answer within ${timeoutMs} ms` }
}

// The start command leads its own process group, so every descendant dies with it on both
// POSIX (negative pid) and Windows (direct child only; Windows has no process groups).
function killGroup(child, signal) {
  if (child.pid == null) return
  if (process.platform === 'win32') { try { child.kill(signal) } catch {} ; return }
  try { process.kill(-child.pid, signal) }
  catch (error) { if (error?.code !== 'ESRCH') try { child.kill(signal) } catch {} }
}

async function terminateGroup(child) {
  killGroup(child, 'SIGTERM')
  if (await waitExit(child, TERMINATE_GRACE_MS)) return
  killGroup(child, 'SIGKILL')
  await waitExit(child, TERMINATE_GRACE_MS)
}

async function runStart(recipe, cwd, port, settings, signal) {
  const url = `http://127.0.0.1:${port}${recipe.readinessPath}`
  const started = Date.now()
  const child = spawnShell(recipe.start, cwd, settings.env)
  const collector = tailCollector(settings.maxOutputChars)
  collect(child.stdout, collector.add)
  collect(child.stderr, collector.add)
  // A failed spawn would otherwise be an unhandled 'error' event, which crashes the host.
  let spawnFailure = null
  child.on('error', error => { spawnFailure = cleanText(error?.message || error, 200) })
  let outcome
  try { outcome = await pollReadiness(url, settings.readinessTimeoutMs, signal) }
  finally { await terminateGroup(child) }
  return {
    url, ready: outcome.ready && !spawnFailure, statusCode: outcome.statusCode, error: spawnFailure || outcome.error,
    pid: child.pid, durationMs: Date.now() - started, output: redactText(collector.get(), cwd, settings.maxOutputChars),
  }
}

function runArgv(file, args, cwd, timeoutMs, env) {
  return new Promise(resolve => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const out = tailCollector(2048)
    collect(child.stdout, out.add)
    collect(child.stderr, out.add)
    let timedOut = false, spawnError = null
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
    const finish = code => {
      clearTimeout(timer)
      resolve({ code, timedOut, stdout: out.get(), error: spawnError })
    }
    child.on('error', error => { spawnError = cleanText(error?.message || error, 200) })
    child.on('close', code => finish(code))
  })
}

// Best-effort read-only probe. Anything short of a clean `docker compose ps` that reports no
// running container leaves running containers possible, and rebuilding or starting a live
// compose project replaces its containers; the run is refused instead.
async function composeRefusalReason(cwd, settings) {
  const probe = await runArgv('docker', ['compose', 'ps', '--status', 'running', '--format', '{{.Name}}'], cwd, COMPOSE_PROBE_TIMEOUT_MS, settings.env)
  const detail = redactText(probe.stdout.trim().split('\n').pop() || 'no output', cwd, 200)
  if (probe.error) return `docker compose ps could not run (${probe.error}); running containers cannot be ruled out`
  if (probe.timedOut) return 'docker compose ps timed out; running containers cannot be ruled out'
  if (probe.code !== 0) return `docker compose ps failed (exit ${probe.code}): ${detail}`
  const names = probe.stdout.split('\n').map(name => name.trim()).filter(Boolean)
  return names.length ? `this compose project already has running container(s): ${names.join(', ')}` : null
}

export async function runRecipe(cwd, recipe, config = {}, run = {}) {
  const clean = normalizeRecipe(recipe)
  if (!clean) throw new Error('runRecipe requires a recipe with a name.')
  const settings = {
    commandTimeoutMs: config.commandTimeoutMs ?? DEFAULT_CONFIG.commandTimeoutMs,
    maxOutputChars: config.maxOutputChars ?? DEFAULT_CONFIG.maxOutputChars,
    readinessTimeoutMs: config.recipeReadinessTimeoutMs ?? RECIPE_DEFAULT_OPTIONS.recipeReadinessTimeoutMs,
    env: run.env ?? process.env,
  }
  const requestedPhases = Array.isArray(run.phases) ? run.phases : null
  const selected = RECIPE_PHASES.filter(phase => (requestedPhases ?? RECIPE_PHASES).includes(phase))
  if (!selected.length) throw new Error('No valid recipe phase was selected.')
  const startRequested = Boolean(clean.start) && selected.includes('start') && !run.skipStart
  const willBuild = selected.includes('build') && clean.build.length > 0
  const started = Date.now()
  // Only a run over every phase, with the start included and no early stop, is full scope.
  const scopeReason = requestedPhases ? 'phase-subset' : run.skipStart ? 'start-skipped' : 'stopped-early'
  const result = (pass, phases, readiness, reason = null) => ({
    recipe: { name: clean.name, kind: clean.kind }, pass, reason,
    scope: pass && scopeReason === 'stopped-early' ? 'full' : 'targeted',
    scopeReason: pass && scopeReason === 'stopped-early' ? null : scopeReason,
    phases, readiness, durationMs: Date.now() - started,
  })

  if (clean.kind === 'compose' && (willBuild || startRequested)) {
    const reason = await composeRefusalReason(cwd, settings)
    if (reason) {
      const phase = willBuild ? 'build' : 'start'
      return result(false, [{ phase, command: willBuild ? clean.build[0] : clean.start, exitCode: 1, ok: false, timedOut: false, aborted: false, durationMs: 0, error: reason, output: reason }], null, reason)
    }
  }

  const phases = []
  for (const phase of selected) {
    if (phase === 'start') continue
    for (const command of clean[phase]) {
      const phaseResult = await runPhaseCommand(phase, command, cwd, settings, run.signal)
      phases.push(phaseResult)
      if (!phaseResult.ok && run.stopOnFailure !== false) return result(false, phases, null)
    }
  }
  const readiness = startRequested ? await runStart(clean, cwd, run.portOverride ?? clean.port ?? 8000, settings, run.signal) : null
  if (readiness) phases.push({ phase: 'start', command: clean.start, exitCode: null, ok: readiness.ready, timedOut: false, aborted: readiness.error === 'aborted', durationMs: readiness.durationMs, error: readiness.error, output: readiness.output })
  // A selection whose phases are all absent from the recipe ran nothing, and reporting that
  // as a pass would credit verification to a command that never executed.
  if (!phases.length) return result(false, [], null, 'none of the selected phases had a command to run')
  return result(phases.every(phase => phase.ok), phases, readiness)
}
