import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { runRecipe } from '../lib/recipe-runner.js'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recipe-run-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Bind port 0, read the assigned port, release it. A narrow race remains, but a collision
// makes the test fail loudly rather than pass by accident.
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function respondOn(t, port, statusCode) {
  const server = http.createServer((request, response) => { response.writeHead(statusCode, { 'content-type': 'text/plain' }); response.end('answered') })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  return server
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const groupAlive = pid => { try { process.kill(-pid, 0); return true } catch { return false } }

// Control for the two probes the teardown tests rely on: a live pid and a live process group
// must both report alive, so an assertion that they report dead cannot pass vacuously.
test('the pid and process-group probes report a live group as alive', async t => {
  assert.equal(alive(process.pid), true)
  const child = spawn('node -e "setInterval(() => {}, 1000)"', [], { detached: true, stdio: 'ignore', shell: '/bin/sh' })
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} })
  await waitFor(() => alive(child.pid))
  assert.equal(alive(child.pid), true)
  assert.equal(groupAlive(child.pid), true)
  process.kill(-child.pid, 'SIGKILL')
  await waitFor(() => !groupAlive(child.pid))
  assert.equal(groupAlive(child.pid), false)
})

// Writes its own pid, its child's pid and the pid of the shell the runner spawned
// (process.ppid, which is the leader of the start process group), then optionally serves
// HTTP. Readiness proves the files were already written, so the teardown assertions cannot
// race the process start.
function sleeperSource(listen) {
  return `import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
const write = (name, value) => fs.writeFileSync(path.join(process.env.PID_DIR, name), String(value))
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
write('parent.pid', process.pid)
write('child.pid', child.pid)
write('shell.pid', process.ppid)
${listen ? "http.createServer((request, response) => { response.writeHead(200); response.end('ok') }).listen(Number(process.env.PORT), '127.0.0.1')" : ''}
setInterval(() => {}, 1000)
`
}
const readPid = (dir, name) => Number(fs.readFileSync(path.join(dir, name), 'utf8'))

const step = name => `node -e "require('fs').appendFileSync('steps.txt','${name}\\n')"`
const writeMarker = name => `node -e "require('fs').writeFileSync('${name}','x')"`

test('bootstrap, build and test run in order and stop at the first failure', async t => {
  const cwd = tempDir(t)
  const recipe = { name: 'ordered', kind: 'node', bootstrap: [step('bootstrap')], build: [step('build'), 'node -e "process.exit(3)"'], test: [step('test')] }
  const result = await runRecipe(cwd, recipe, { commandTimeoutMs: 10_000, maxOutputChars: 1000 })
  assert.equal(fs.readFileSync(path.join(cwd, 'steps.txt'), 'utf8'), 'bootstrap\nbuild\n')
  assert.deepEqual(result.phases.map(p => [p.phase, p.exitCode, p.ok]), [['bootstrap', 0, true], ['build', 0, true], ['build', 3, false]])
  assert.equal(result.pass, false)
  assert.equal(result.scope, 'targeted')
  assert.equal(result.scopeReason, 'stopped-early')
})

test('a run over every phase records a full-scope receipt', async t => {
  const cwd = tempDir(t)
  const recipe = { name: 'complete', kind: 'node', bootstrap: [step('bootstrap')], build: [step('build')], test: [step('test')] }
  const result = await runRecipe(cwd, recipe, { commandTimeoutMs: 10_000 })
  assert.equal(result.pass, true)
  assert.equal(result.scope, 'full')
  assert.equal(result.scopeReason, null)
  assert.deepEqual(result.phases.map(p => p.phase), ['bootstrap', 'build', 'test'])
  assert.equal(result.durationMs >= 0, true)
})

test('a phase subset and a start skip each record a targeted receipt', async t => {
  const cwd = tempDir(t)
  const port = await freePort()
  await respondOn(t, port, 200)
  const recipe = { name: 'partial', kind: 'node', build: [step('build')], test: [step('test')], start: 'node -e "setInterval(() => {}, 1000)"', port }
  const subset = await runRecipe(cwd, recipe, { commandTimeoutMs: 10_000 }, { phases: ['build'] })
  assert.deepEqual(subset.phases.map(p => p.phase), ['build'])
  assert.equal(subset.pass, true)
  assert.equal(subset.scope, 'targeted')
  assert.equal(subset.scopeReason, 'phase-subset')
  const skipped = await runRecipe(cwd, recipe, { commandTimeoutMs: 10_000, recipeReadinessTimeoutMs: 2000 }, { skipStart: true })
  assert.deepEqual(skipped.phases.map(p => p.phase), ['build', 'test'])
  assert.equal(skipped.readiness, null)
  assert.equal(skipped.pass, true)
  assert.equal(skipped.scope, 'targeted')
  assert.equal(skipped.scopeReason, 'start-skipped')
})

test('a command over the configured timeout is stopped and reported as timed out', async t => {
  const cwd = tempDir(t)
  const started = Date.now()
  const result = await runRecipe(cwd, { name: 'slow', kind: 'node', test: ['node -e "setTimeout(() => {}, 5000)"'] }, { commandTimeoutMs: 400, maxOutputChars: 1000 })
  assert.equal(result.phases[0].timedOut, true)
  assert.equal(result.phases[0].ok, false)
  assert.equal(result.pass, false)
  assert.ok(Date.now() - started < 3000, `run took ${Date.now() - started} ms`)
})

test('an aborted run stops the phase command and reports it as aborted', async t => {
  const cwd = tempDir(t)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 250)
  const started = Date.now()
  const result = await runRecipe(cwd, { name: 'aborted', kind: 'node', test: ['node -e "setTimeout(() => {}, 5000)"'] }, { commandTimeoutMs: 10_000, maxOutputChars: 1000 }, { signal: controller.signal })
  assert.equal(result.phases[0].aborted, true)
  assert.equal(result.phases[0].ok, false)
  assert.equal(result.pass, false)
  assert.ok(Date.now() - started < 3000, `run took ${Date.now() - started} ms`)
})

test('phase output is bounded to the tail of the command output', async t => {
  const cwd = tempDir(t)
  const recipe = { name: 'noisy', kind: 'node', test: [`node -e "process.stdout.write('x'.repeat(5000) + 'TAIL-MARK')"`] }
  const result = await runRecipe(cwd, recipe, { commandTimeoutMs: 10_000, maxOutputChars: 200 })
  const output = result.phases[0].output
  assert.equal(result.phases[0].ok, true)
  assert.ok(output.length <= 201, `output was ${output.length} chars`)
  assert.ok(output.endsWith('TAIL-MARK'), output.slice(-30))
  assert.ok(output.startsWith('…'), output.slice(0, 30))
})

test('phase output has the workspace path redacted', async t => {
  const cwd = tempDir(t)
  const recipe = { name: 'redact', kind: 'node', test: ['node -e "process.stdout.write(process.cwd())"'] }
  const result = await runRecipe(cwd, recipe, { commandTimeoutMs: 10_000, maxOutputChars: 12_000 })
  assert.equal(result.phases[0].output, '[workspace]')
})

for (const statusCode of [200, 404, 500]) {
  test(`an HTTP ${statusCode} answer counts as ready`, async t => {
    const cwd = tempDir(t)
    const port = await freePort()
    await respondOn(t, port, statusCode)
    const recipe = { name: 'ready', kind: 'node', start: 'node -e "setInterval(() => {}, 1000)"', port, readinessPath: '/health' }
    const result = await runRecipe(cwd, recipe, { commandTimeoutMs: 10_000, recipeReadinessTimeoutMs: 5000 }, { phases: ['start'] })
    assert.equal(result.readiness.ready, true)
    assert.equal(result.readiness.statusCode, statusCode)
    assert.equal(result.readiness.url, `http://127.0.0.1:${port}/health`)
    assert.equal(result.pass, true)
  })
}

test('readiness fails when nothing answers within the readiness timeout', async t => {
  const cwd = tempDir(t)
  const port = await freePort()
  const recipe = { name: 'unready', kind: 'node', start: 'node -e "setInterval(() => {}, 1000)"', port }
  const started = Date.now()
  const result = await runRecipe(cwd, recipe, { commandTimeoutMs: 10_000, recipeReadinessTimeoutMs: 600 }, { phases: ['start'] })
  const elapsed = Date.now() - started
  assert.equal(result.readiness.ready, false)
  assert.equal(result.readiness.statusCode, null)
  assert.equal(typeof result.readiness.error, 'string')
  assert.ok(elapsed >= 600, `readiness gave up after ${elapsed} ms`)
  assert.ok(elapsed < 4000, `readiness took ${elapsed} ms`)
  assert.equal(result.pass, false)
  assert.equal(result.scope, 'targeted')
})

test('the start command leads its own process group, which is gone after the readiness poll', async t => {
  const cwd = tempDir(t)
  const pidDir = path.join(cwd, 'pids')
  fs.mkdirSync(pidDir)
  fs.writeFileSync(path.join(cwd, 'sleeper.mjs'), sleeperSource(true))
  const port = await freePort()
  const recipe = { name: 'teardown', kind: 'node', start: 'node sleeper.mjs', port, readinessPath: '/health' }
  const env = { ...process.env, PID_DIR: pidDir, PORT: String(port) }
  const pending = runRecipe(cwd, recipe, { commandTimeoutMs: 10_000, recipeReadinessTimeoutMs: 5000 }, { phases: ['start'], env })
  await waitFor(() => fs.existsSync(path.join(pidDir, 'shell.pid')))
  const groupPid = readPid(pidDir, 'shell.pid')
  // While the run is still in flight the group must exist and must be its own group: a
  // runner that did not detach would put the start command in the runner's own group, and
  // this probe would report ESRCH.
  assert.equal(groupAlive(groupPid), true, 'the start command does not lead its own process group')
  const result = await pending
  assert.equal(result.pass, true)
  assert.equal(result.readiness.ready, true)
  assert.equal(result.readiness.pid, groupPid, 'readiness.pid is the shell that leads the start group')
  const parentPid = readPid(pidDir, 'parent.pid')
  const childPid = readPid(pidDir, 'child.pid')
  assert.notEqual(parentPid, childPid)
  await waitFor(() => !alive(parentPid) && !alive(childPid) && !groupAlive(groupPid))
  assert.equal(alive(parentPid), false, 'the start command is still running')
  assert.equal(alive(childPid), false, 'a descendant of the start command is still running')
  assert.equal(groupAlive(groupPid), false, 'the start command process group still exists')
})

test('the start process group is gone after a readiness failure too', async t => {
  const cwd = tempDir(t)
  const pidDir = path.join(cwd, 'pids')
  fs.mkdirSync(pidDir)
  fs.writeFileSync(path.join(cwd, 'sleeper.mjs'), sleeperSource(false))
  const port = await freePort()
  const recipe = { name: 'teardown-failed', kind: 'node', start: 'node sleeper.mjs', port }
  const result = await runRecipe(cwd, recipe, { commandTimeoutMs: 10_000, recipeReadinessTimeoutMs: 500 }, { phases: ['start'], env: { ...process.env, PID_DIR: pidDir } })
  assert.equal(result.pass, false)
  assert.equal(result.readiness.ready, false)
  await waitFor(() => fs.existsSync(path.join(pidDir, 'shell.pid')))
  const parentPid = readPid(pidDir, 'parent.pid')
  const childPid = readPid(pidDir, 'child.pid')
  const groupPid = readPid(pidDir, 'shell.pid')
  await waitFor(() => !alive(parentPid) && !alive(childPid) && !groupAlive(groupPid))
  assert.equal(groupAlive(groupPid), false, 'the start command process group still exists')
})

// docker is not the code under test, so its probe result is supplied by a stub on PATH.
function dockerStub(t, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-docker-stub-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return { PATH: `${dir}:${path.dirname(process.execPath)}` }
}

test('a compose recipe refuses to build when containers may be running', async t => {
  const cwd = tempDir(t)
  const env = dockerStub(t, 'echo web-1\nexit 0')
  const port = await freePort()
  const recipe = { name: 'compose-app', kind: 'compose', build: [writeMarker('build-ran')], start: 'node -e "setInterval(() => {}, 1000)"', port }
  const result = await runRecipe(cwd, recipe, { commandTimeoutMs: 10_000, recipeReadinessTimeoutMs: 400 }, { env })
  assert.equal(result.pass, false)
  assert.match(result.reason, /already has running container\(s\): web-1/)
  assert.equal(fs.existsSync(path.join(cwd, 'build-ran')), false, 'the build ran despite the refusal')
  assert.equal(result.scope, 'targeted')
  assert.deepEqual(result.phases.map(phase => phase.phase), ['build'])
})

test('a compose recipe refuses to start when containers may be running', async t => {
  const cwd = tempDir(t)
  const port = await freePort()
  const recipe = { name: 'compose-app', kind: 'compose', start: 'node -e "require(\'fs\').writeFileSync(\'start-ran\',\'x\')"', port }
  const result = await runRecipe(cwd, recipe, { commandTimeoutMs: 10_000, recipeReadinessTimeoutMs: 400 }, { env: dockerStub(t, 'echo web-1\nexit 0') })
  assert.equal(result.pass, false)
  assert.match(result.reason, /already has running container\(s\): web-1/)
  assert.equal(fs.existsSync(path.join(cwd, 'start-ran')), false, 'the start command ran despite the refusal')
  assert.deepEqual(result.phases.map(phase => phase.phase), ['start'])
})

test('a compose recipe refuses when the probe fails, and proceeds when it is clean', async t => {
  const cwd = tempDir(t)
  const failing = await runRecipe(cwd, { name: 'compose-app', kind: 'compose', build: [writeMarker('build-ran')] }, { commandTimeoutMs: 10_000 }, { env: dockerStub(t, 'echo "no daemon" >&2\nexit 1') })
  assert.equal(failing.pass, false)
  assert.match(failing.reason, /docker compose ps failed \(exit 1\)/)
  assert.equal(fs.existsSync(path.join(cwd, 'build-ran')), false)
  const clean = await runRecipe(cwd, { name: 'compose-app', kind: 'compose', build: [writeMarker('build-ran')] }, { commandTimeoutMs: 10_000 }, { env: dockerStub(t, 'exit 0') })
  assert.equal(clean.pass, true)
  assert.equal(clean.scope, 'full')
  assert.equal(fs.readFileSync(path.join(cwd, 'build-ran'), 'utf8'), 'x')
})

test('a missing docker binary refuses a compose build rather than assuming it is safe', async t => {
  const cwd = tempDir(t)
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-no-docker-'))
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }))
  const result = await runRecipe(cwd, { name: 'compose-app', kind: 'compose', build: [writeMarker('build-ran')] }, { commandTimeoutMs: 10_000 }, { env: { PATH: empty } })
  assert.equal(result.pass, false)
  assert.match(result.reason, /cannot be ruled out/)
  assert.equal(fs.existsSync(path.join(cwd, 'build-ran')), false)
})

test('a compose recipe without a build or start phase does not probe docker', async t => {
  const cwd = tempDir(t)
  const result = await runRecipe(cwd, { name: 'compose-app', kind: 'compose', test: [step('test')] }, { commandTimeoutMs: 10_000 }, { env: { PATH: process.env.PATH } })
  assert.equal(result.pass, true)
  assert.equal(result.reason, null)
})

test('a run with stopOnFailure disabled continues past a failure', async t => {
  const cwd = tempDir(t)
  const recipe = { name: 'continue', kind: 'node', build: ['node -e "process.exit(2)"'], test: [step('test')] }
  const result = await runRecipe(cwd, recipe, { commandTimeoutMs: 10_000 }, { stopOnFailure: false })
  assert.deepEqual(result.phases.map(phase => [phase.phase, phase.ok]), [['build', false], ['test', true]])
  assert.equal(result.pass, false)
  assert.equal(fs.readFileSync(path.join(cwd, 'steps.txt'), 'utf8'), 'test\n')
})

// The fallback port is a property of the recipe, not of this machine: 8000 is what the runner
// chooses when the recipe names no port. Readiness against it is deliberately NOT asserted here,
// because an unrelated service may legitimately hold 8000 and would answer the poll, making the
// result depend on the environment. Readiness failure has its own test on a port this suite owns
// ('readiness fails when nothing answers within the readiness timeout').
test('a start command with no resolvable port falls back to 8000', async t => {
  const cwd = tempDir(t)
  const result = await runRecipe(cwd, { name: 'portless', kind: 'node', start: 'node -e "setInterval(() => {}, 1000)"' }, { commandTimeoutMs: 10_000, recipeReadinessTimeoutMs: 300 }, { phases: ['start'] })
  assert.equal(result.readiness.url, 'http://127.0.0.1:8000/')
})

test('a port override replaces the recipe port', async t => {
  const cwd = tempDir(t)
  const port = await freePort()
  await respondOn(t, port, 200)
  const result = await runRecipe(cwd, { name: 'override', kind: 'node', start: 'node -e "setInterval(() => {}, 1000)"', port: 1 }, { commandTimeoutMs: 10_000, recipeReadinessTimeoutMs: 5000 }, { phases: ['start'], portOverride: port })
  assert.equal(result.readiness.url, `http://127.0.0.1:${port}/`)
  assert.equal(result.pass, true)
})

test('a selection whose phases hold no command is not credited as a pass', async t => {
  const cwd = tempDir(t)
  const result = await runRecipe(cwd, { name: 'empty-phases', kind: 'node', test: [step('test')] }, { commandTimeoutMs: 10_000 }, { phases: ['bootstrap', 'build'] })
  assert.deepEqual(result.phases, [])
  assert.equal(result.pass, false)
  assert.match(result.reason, /none of the selected phases had a command to run/)
  assert.equal(result.scope, 'targeted')
})

test('no valid phase selection is rejected instead of silently doing nothing', async t => {
  const cwd = tempDir(t)
  await assert.rejects(() => runRecipe(cwd, { name: 'x', kind: 'node', test: ['node -e ""'] }, { commandTimeoutMs: 1000 }, { phases: ['nope'] }), /No valid recipe phase/)
  await assert.rejects(() => runRecipe(cwd, { kind: 'node' }, {}), /requires a recipe with a name/)
})

// The requirement is that no hook starts a recipe on its own. This asserts the part that is
// decidable here: the runner is a plain module (no plugin `apply`/`name`/`inject` export, so
// the host cannot activate it) and it exposes only the explicit entry point. The stop hook
// lives in lib/index.js and is wired by the recipe action ticket.
test('the runner is not a plugin and exposes only the explicit entry point', async () => {
  const module = await import('../lib/recipe-runner.js')
  assert.deepEqual(Object.keys(module), ['runRecipe'])
})
