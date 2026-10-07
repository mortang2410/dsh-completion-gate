import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompletionGateService } from '../lib/index.js'
import { RECIPE_MANIFEST_RELPATH } from '../lib/recipe.js'
import { verificationInventory } from '../lib/verification.js'
import { VerificationLedger, ledgerRow } from '../lib/ledger.js'
import { resolveConfig } from '../lib/core.js'

function tempDir(t, prefix = 'cg-verify-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function recorder(entries = new Map()) {
  const announced = []
  return { announced, entries, summary: (id, seq) => { announced.push(seq); return entries.get(`${id}:${seq}`) }, async diff() { return undefined } }
}

function service(t, { cwd, settings = {}, workspaceChanges = recorder() } = {}) {
  const dir = tempDir(t, 'cg-settings-')
  const ctx = { reflect: { get: name => (name === 'workspaceChanges' ? workspaceChanges : undefined) } }
  const instance = new CompletionGateService(ctx, settings, { settingsPath: path.join(dir, 'settings.json') })
  if (cwd) {
    instance.cwdBySession.set('session-1', cwd)
    instance.rootCache.set(cwd, cwd)
  }
  return instance
}

function agentFor(cwd, id = 'session-1') {
  const steers = [], followups = []
  return { id, session: { header: { cwd }, events: [] }, steer: m => steers.push(m), followup: m => followups.push(m), steers, followups }
}

function announce(svc, sessionId, turn, seq, files) {
  svc.changes.observe({ id: sessionId }, { type: 'turn/start', data: { turn } })
  svc.changes.observe({ id: sessionId }, { type: 'workspace/changes', seq, data: { turn } })
  svc.changeService().entries.set(`${sessionId}:${seq}`, { turn, cwd: '/repo', files, total: files.length, added: files.length, deleted: 0 })
}

const file = (p) => ({ path: p, display: p, added: 1, deleted: 0 })

test('a passing verification covers the missing-harness condition whatever its scope', async t => {
  const cwd = tempDir(t)
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'probe', scripts: { start: 'node -e "setInterval(()=>{},1000)"' } }))
  const svc = service(t, { cwd, settings: { requireTests: true, requireAttestation: false, recipeReadinessTimeoutMs: 2000 } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])

  // Before any evidence: the machine layer reports the missing harness and the gate blocks.
  const before = await svc.run(agentFor(cwd), new AbortController().signal, { force: true })
  assert.equal(before.pass, false)
  assert.match(before.blockers.join(' '), /No executable test command/)

  // A phase subset records a TARGETED receipt. This subset holds no command, so the run is a
  // failure, and a failed run never satisfies anything whatever its scope.
  const targeted = await svc.recipe(agentFor(cwd), { phases: ['build'] })
  assert.equal(targeted.run.scope, 'targeted')
  assert.equal(targeted.run.pass, false)
  assert.equal(targeted.report.pass, false, 'a failed run must not satisfy the requirement')

  // A passing TARGETED receipt covers the missing harness, because scope is recorded rather
  // than gated. This is the regression test for the last-resort path: gating on full scope left
  // the temporary verifier unable to clear the one blocker it exists to clear.
  svc.ledger.clear('session-1')
  svc.recordVerification(agentFor(cwd), await svc.turnChanges(agentFor(cwd)), { source: 'recipe', name: 'node', kind: 'node', scope: 'targeted', pass: true, output: 'ok' })
  const targetedReport = await svc.run(agentFor(cwd), new AbortController().signal, { force: true })
  assert.equal(targetedReport.verificationCoveredMissingHarness, true, 'a fresh passing targeted receipt covers the missing harness')
  assert.equal(targetedReport.pass, true)

  // A complete run records a full-scope pass, which covers the missing harness in the same way.
  svc.ledger.clear('session-1')
  svc.recordVerification(agentFor(cwd), await svc.turnChanges(agentFor(cwd)), { source: 'recipe', name: 'node', kind: 'node', scope: 'full', pass: true, output: 'ok' })
  const report = await svc.run(agentFor(cwd), new AbortController().signal, { force: true })
  assert.equal(report.machinePass, false, 'the machine layer still computes the missing harness')
  assert.ok(report.blockers.length === 0 || !report.blockers.some(x => /No executable test command/.test(x)), `missing harness was not covered: ${JSON.stringify(report.blockers)}`)
  assert.equal(report.verificationCoveredMissingHarness, true)
  assert.equal(report.pass, true)
})

test('a failed required check is never covered by passing verification evidence', async t => {
  const cwd = tempDir(t)
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'failing', scripts: { test: 'node -e "process.exit(1)"' } }))
  const svc = service(t, { cwd, settings: { requireTests: true, requireAttestation: false } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  svc.recordVerification(agentFor(cwd), await svc.turnChanges(agentFor(cwd)), { source: 'recipe', name: 'node', kind: 'node', scope: 'full', pass: true, output: 'ok' })
  const report = await svc.run(agentFor(cwd), new AbortController().signal, { force: true })
  assert.equal(report.pass, false, 'a real failure must still block')
  assert.match(report.blockers.join(' '), /failed/)
})

test('a pass goes stale after a later turn edits the workspace', async t => {
  const cwd = tempDir(t)
  const svc = service(t, { cwd, settings: { requireAttestation: false, requireTests: false } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const first = await svc.turnChanges(agentFor(cwd))
  svc.recordVerification(agentFor(cwd), first, { source: 'recipe', name: 'node', kind: 'node', scope: 'full', pass: true, output: 'ok' })
  assert.equal((await svc.run(agentFor(cwd), new AbortController().signal, { force: true })).verificationCoveredMissingHarness, false)
  assert.equal(svc.ledger.satisfied('session-1', first.fingerprint), true)

  // A later turn changes a file, so the earlier pass describes an older state of the code.
  announce(svc, 'session-1', 2, 20, [file('app.js'), file('changed.js')])
  const second = await svc.turnChanges(agentFor(cwd))
  assert.notEqual(second.fingerprint, first.fingerprint)
  assert.equal(svc.ledger.satisfied('session-1', second.fingerprint), false, 'the earlier pass is stale')
  assert.equal(svc.ledger.rowsFor('session-1').length, 1, 'the stale row is kept for the record')
})

test('the inventory decides each precedence case', async t => {
  const withTest = tempDir(t)
  fs.writeFileSync(path.join(withTest, 'package.json'), JSON.stringify({ name: 'has-test', scripts: { test: 'node -e ""' } }))
  // A project with no canonical test/build/lint/typecheck script at all, but a `dev` script a
  // recipe can boot and poll.
  const noTest = tempDir(t)
  fs.writeFileSync(path.join(noTest, 'package.json'), JSON.stringify({ name: 'no-check', scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }))
  const bare = tempDir(t)

  const inventoryFor = (cwd, over = {}) => verificationInventory({
    cwd, config: resolveConfig({ requireTests: true, ...over }), ledger: new VerificationLedger(), sessionId: 's1', fingerprint: 'fp',
  })

  // A canonical check exists: it is the source, and the fallback is refused.
  const canonical = inventoryFor(withTest)
  assert.equal(canonical.selected, 'canonical')
  assert.equal(canonical.temporary.eligible, false)
  assert.match(canonical.temporary.reason, /canonical check exists/)

  // No canonical test, but a usable recipe: the recipe is the source.
  const recipe = inventoryFor(noTest)
  assert.equal(recipe.selected, 'recipe')
  assert.equal(recipe.recipe.usable, true)
  assert.equal(recipe.temporary.eligible, false)
  assert.match(recipe.temporary.reason, /usable recipe exists/)

  // Neither: the temporary fallback is eligible.
  const none = inventoryFor(bare)
  assert.equal(none.selected, 'temporary')
  assert.equal(none.temporary.eligible, true)
  assert.equal(none.temporary.reason, null)

  // A saved manifest that exists but cannot be used is operator intent that cannot be honoured,
  // so the fallback is refused rather than silently substituted.
  const savedUnusable = tempDir(t)
  const manifestFile = path.join(savedUnusable, RECIPE_MANIFEST_RELPATH)
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
  fs.writeFileSync(manifestFile, '{ this is not json')
  const blocked = inventoryFor(savedUnusable)
  assert.equal(blocked.temporary.eligible, false)
  assert.match(blocked.temporary.reason, /configured but unavailable/)

  // Disabled by configuration.
  const disabled = inventoryFor(bare, { allowTemporaryVerifier: false })
  assert.equal(disabled.temporary.eligible, false)
  assert.match(disabled.temporary.reason, /disabled by configuration/)
})

test('a documentation-only turn has no verification requirement at all', async t => {
  const bare = tempDir(t)
  const inventory = verificationInventory({ cwd: bare, config: resolveConfig({ requireTests: true }), ledger: new VerificationLedger(), sessionId: 's1', fingerprint: 'fp', documentationOnly: true })
  assert.equal(inventory.selected, 'none')
  assert.equal(inventory.satisfied, true)
  assert.equal(inventory.temporary.eligible, false)
})

test('a recipe action inspects without running and saves a manifest that reloads', async t => {
  const cwd = tempDir(t)
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'saveable', scripts: { build: 'node -e ""', test: 'node -e ""' } }))
  const svc = service(t, { cwd, settings: { requireAttestation: false } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])

  const inspected = await svc.recipe(agentFor(cwd), { inspect: true })
  assert.equal(inspected.inspect, true)
  assert.equal(inspected.source, 'detected')
  assert.equal(inspected.recipe.name, 'Node.js app')
  assert.equal(fs.existsSync(path.join(cwd, RECIPE_MANIFEST_RELPATH)), false, 'inspect must run and write nothing')

  const saved = await svc.recipe(agentFor(cwd), { save: true })
  assert.equal(saved.ok, true)
  assert.equal(fs.existsSync(path.join(cwd, RECIPE_MANIFEST_RELPATH)), true)

  const reloaded = await svc.recipe(agentFor(cwd), { inspect: true })
  assert.equal(reloaded.source, 'manifest', 'a saved recipe wins over detection')
  assert.deepEqual(reloaded.recipe, inspected.recipe, 'the saved recipe is what detection produced')
})

test('a recipe action reports clearly when nothing resolves', async t => {
  const cwd = tempDir(t)
  const svc = service(t, { cwd, settings: { requireAttestation: false } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const outcome = await svc.recipe(agentFor(cwd), {})
  assert.equal(outcome.ok, false)
  assert.match(outcome.blockers.join(' '), /No verification recipe resolved/)
})

test('the temporary verifier records a targeted receipt and deletes a passing script', async t => {
  const cwd = tempDir(t)
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const script = path.join(os.tmpdir(), `dsh-verify-${process.pid}-${Date.now()}.mjs`)
  fs.writeFileSync(script, 'process.exit(0)\n')

  const outcome = await svc.temporaryVerify(agentFor(cwd), { script_path: script, runtime: 'node' })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.run.pass, true)
  assert.equal(fs.existsSync(script), false, 'a passing script is deleted')

  const rows = svc.ledger.rowsFor('session-1')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'temporary')
  assert.equal(rows[0].scope, 'targeted', 'a temporary script is never a full-scope pass')
  const report = await svc.run(agentFor(cwd), new AbortController().signal, { force: true })
  assert.equal(report.verificationCoveredMissingHarness, true, 'a fresh passing temporary script clears the missing-harness blocker')
  assert.equal(report.pass, true, 'the last-resort path is a real path to completion')
})

test('the temporary verifier refuses each invalid script path', async t => {
  const cwd = tempDir(t)
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const agent = agentFor(cwd)
  const run = args => svc.temporaryVerify(agent, args)

  // Relative path.
  assert.match((await run({ script_path: 'dsh-verify-rel.mjs', runtime: 'node' })).blockers.join(' '), /must be absolute/)
  // A path inside the repository (the lexical check).
  const inside = path.join(cwd, 'dsh-verify-inside.mjs')
  fs.writeFileSync(inside, 'process.exit(0)\n')
  assert.match((await run({ script_path: inside, runtime: 'node' })).blockers.join(' '), /outside the project repository/)
  // Wrong prefix.
  const wrongName = path.join(os.tmpdir(), `not-a-probe-${process.pid}.mjs`)
  fs.writeFileSync(wrongName, 'process.exit(0)\n')
  t.after(() => fs.rmSync(wrongName, { force: true }))
  assert.match((await run({ script_path: wrongName, runtime: 'node' })).blockers.join(' '), /must start with/)
  // Non-existent path.
  assert.match((await run({ script_path: path.join(os.tmpdir(), 'dsh-verify-absent.mjs'), runtime: 'node' })).blockers.join(' '), /does not exist/)
  // Size over the cap.
  const big = path.join(os.tmpdir(), `dsh-verify-big-${process.pid}.mjs`)
  fs.writeFileSync(big, `// ${'x'.repeat(300 * 1024)}\n`)
  t.after(() => fs.rmSync(big, { force: true }))
  assert.match((await run({ script_path: big, runtime: 'node' })).blockers.join(' '), /over the .* cap/)
  // A runtime outside the fixed list. The path itself is valid so only the runtime is refused.
  assert.match((await run({ script_path: path.join(os.tmpdir(), 'dsh-verify-runtime.mjs'), runtime: 'zsh' })).blockers.join(' '), /Runtime must be one of/)
  // A directory rather than a regular file, with a valid prefix so only that rule is exercised.
  const dirPath = path.join(os.tmpdir(), `dsh-verify-dir-${process.pid}`)
  fs.mkdirSync(dirPath, { recursive: true })
  t.after(() => fs.rmSync(dirPath, { recursive: true, force: true }))
  assert.match((await run({ script_path: dirPath, runtime: 'node' })).blockers.join(' '), /regular file/)
})

test('a symlink in the temporary directory pointing into the repository is refused', async t => {
  const cwd = tempDir(t)
  const target = path.join(cwd, 'dsh-verify-inner.mjs')
  fs.writeFileSync(target, 'process.exit(0)\n')
  const link = path.join(os.tmpdir(), `dsh-verify-link-${process.pid}-${Date.now()}.mjs`)
  fs.symlinkSync(target, link)
  t.after(() => fs.rmSync(link, { force: true }))

  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const outcome = await svc.temporaryVerify(agentFor(cwd), { script_path: link, runtime: 'node' })
  assert.equal(outcome.ok, false, 'a symlink must not smuggle project code past the containment check')
  assert.match(outcome.blockers.join(' '), /outside the project repository/)
})

test('a workspace too large to fingerprint refuses the temporary verifier', async t => {
  const cwd = tempDir(t)
  // More files than the fingerprint cap. A partial listing cannot prove a file outside it was
  // left alone, so the run must be refused rather than reported as a pass.
  const many = 5001
  for (let i = 0; i < many; i += 1) fs.writeFileSync(path.join(cwd, `f${String(i).padStart(5, '0')}.txt`), 'x')
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const script = path.join(os.tmpdir(), `dsh-verify-toobig-${process.pid}-${Date.now()}.mjs`)
  fs.writeFileSync(script, 'process.exit(0)\n')
  t.after(() => fs.rmSync(script, { force: true }))

  const outcome = await svc.temporaryVerify(agentFor(cwd), { script_path: script, runtime: 'node' })
  // The run is refused before the script starts, so exitCode is null and the script is untouched.
  assert.equal(outcome.run.exitCode, null)
  assert.equal(outcome.run.pass, false, 'an unfingerprintable workspace must not be reported as verified')
  assert.match(outcome.run.detail, /cannot be compared before and after the run: it holds more than 5000 entries/)
  assert.equal(fs.existsSync(script), true, 'a refused run leaves the script alone')
  assert.equal(svc.ledger.rowsFor('session-1')[0].pass, false)
})

test('a run that pushes the workspace past the fingerprint cap is refused', async t => {
  const cwd = tempDir(t)
  // Exactly at the cap before the run, so the before-fingerprint completes. The probe then ADDS a
  // file, which makes the after-fingerprint exceed the cap. A null after-fingerprint is not proof
  // of a clean tree, so the run must be refused rather than reported as a pass.
  for (let i = 0; i < 5000; i += 1) fs.writeFileSync(path.join(cwd, `f${String(i).padStart(5, '0')}.txt`), 'x')
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const added = path.join(cwd, 'zz-added.txt')
  const script = path.join(os.tmpdir(), `dsh-verify-grow-${process.pid}-${Date.now()}.mjs`)
  fs.writeFileSync(script, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(added)}, 'new')\nprocess.exit(0)\n`)
  t.after(() => fs.rmSync(script, { force: true }))

  const outcome = await svc.temporaryVerify(agentFor(cwd), { script_path: script, runtime: 'node' })
  assert.equal(fs.existsSync(added), true, 'precondition: the script really did add a file')
  assert.equal(outcome.run.exitCode, 0, 'precondition: the script itself succeeded')
  assert.equal(outcome.run.pass, false, 'an unverifiable after-state must not be reported as verified')
  assert.match(outcome.run.detail, /could not be compared after the run: it holds more than 5000 entries/)
  assert.equal(svc.ledger.rowsFor('session-1')[0].pass, false)
})

test('a same-size rewrite with a nanosecond modification-time restore is still detected', async t => {
  const cwd = tempDir(t)
  const victim = path.join(cwd, 'app.js')
  fs.writeFileSync(victim, 'AAAA')
  const before = fs.statSync(victim, { bigint: true })
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const script = path.join(os.tmpdir(), `dsh-verify-samesize-ns-${process.pid}-${Date.now()}.py`)
  // Python, not Node: os.utime(ns=...) restores the exact nanosecond mtime, whereas Node's
  // utimesSync lands slightly off. Against a size+mtime comparison this rewrite was invisible,
  // so the probe must be caught by comparing contents instead. The atime and mtime are read from
  // the filesystem by the probe itself, never hard-coded here.
  fs.writeFileSync(script, [
    'import os, sys',
    `p = ${JSON.stringify(victim)}`,
    'st = os.stat(p)',
    "open(p, 'wb').write(b'BBBB')",
    'os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))',
    'sys.exit(0)',
  ].join('\n') + '\n')
  t.after(() => fs.rmSync(script, { force: true }))

  const outcome = await svc.temporaryVerify(agentFor(cwd), { script_path: script, runtime: 'python3' })
  const after = fs.statSync(victim, { bigint: true })
  assert.equal(fs.readFileSync(victim, 'utf8'), 'BBBB', 'precondition: the file content really changed')
  assert.equal(after.size, before.size, 'precondition: the size did not change')
  assert.equal(after.mtimeNs, before.mtimeNs, 'precondition: the nanosecond mtime was restored exactly')
  assert.equal(outcome.run.mutatedRepository, true, 'a same-size rewrite with a restored mtime must still be caught')
  assert.equal(outcome.run.pass, false)
})

test('a probe that edits only inside a skipped directory is not detected (stated ceiling)', async t => {
  // A known, accepted ceiling, recorded rather than hidden: dependencies and VCS internals are not
  // the code under test, and walking node_modules would exceed the file bound on nearly every Node
  // project. This test pins the LIMIT, so nobody reads a passing probe as proof that no file
  // anywhere changed.
  const cwd = tempDir(t)
  fs.mkdirSync(path.join(cwd, 'node_modules', 'dep'), { recursive: true })
  const dependency = path.join(cwd, 'node_modules', 'dep', 'index.js')
  fs.writeFileSync(dependency, 'module.exports = 1\n')
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const script = path.join(os.tmpdir(), `dsh-verify-skipped-${process.pid}-${Date.now()}.mjs`)
  fs.writeFileSync(script, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(dependency)}, 'module.exports = 999\\n')\nprocess.exit(0)\n`)
  t.after(() => fs.rmSync(script, { force: true }))

  const outcome = await svc.temporaryVerify(agentFor(cwd), { script_path: script, runtime: 'node' })
  assert.equal(fs.readFileSync(dependency, 'utf8'), 'module.exports = 999\n', 'precondition: the dependency really changed')
  assert.equal(outcome.run.mutatedRepository, false, 'ceiling: an edit inside node_modules is not seen by the fingerprint')
  assert.equal(outcome.run.pass, true, 'ceiling: the probe still passes, because dependencies are outside the declared scope')
})

test('a probe that writes outside the workspace root is not detected (stated ceiling)', async t => {
  // The second accepted ceiling: the comparison covers the project root only. A write elsewhere on
  // the machine is outside the declared scope, which is why the plugin also requires the script to
  // live outside the repository. Recorded here so the boundary is explicit.
  const cwd = tempDir(t)
  const outside = tempDir(t, 'cg-verify-outside-')
  const victim = path.join(outside, 'target.txt')
  fs.writeFileSync(victim, 'ORIGINAL')
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const script = path.join(os.tmpdir(), `dsh-verify-outside-${process.pid}-${Date.now()}.mjs`)
  fs.writeFileSync(script, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(victim)}, 'MUTATED')\nprocess.exit(0)\n`)
  t.after(() => fs.rmSync(script, { force: true }))

  const outcome = await svc.temporaryVerify(agentFor(cwd), { script_path: script, runtime: 'node' })
  assert.equal(fs.readFileSync(victim, 'utf8'), 'MUTATED', 'precondition: the outside file really changed')
  assert.equal(outcome.run.mutatedRepository, false, 'ceiling: a write outside the root is not seen by the fingerprint')
  assert.equal(outcome.run.pass, true, 'ceiling: the probe still passes, because the comparison is scoped to the root')
})

test('a probe that hides an edit behind an unreadable file is refused', async t => {
  const cwd = tempDir(t)
  const victim = path.join(cwd, 'secret.txt')
  fs.writeFileSync(victim, 'ORIGINAL')
  fs.chmodSync(victim, 0o000)
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const script = path.join(os.tmpdir(), `dsh-verify-unreadable-${process.pid}-${Date.now()}.mjs`)
  // The probe makes the file readable only long enough to rewrite it with the same byte length,
  // then hides it again. A walk that skipped unreadable files would see no change at all.
  fs.writeFileSync(script, [
    "import fs from 'node:fs'",
    `const p = ${JSON.stringify(victim)}`,
    "fs.chmodSync(p, 0o600)",
    "fs.writeFileSync(p, 'MUTATED!')",
    "fs.chmodSync(p, 0o000)",
    'process.exit(0)',
  ].join('\n') + '\n')
  t.after(() => { try { fs.chmodSync(victim, 0o600) } catch {} ; fs.rmSync(script, { force: true }) })

  const outcome = await svc.temporaryVerify(agentFor(cwd), { script_path: script, runtime: 'node' })
  assert.equal(outcome.run.pass, false, 'an unreadable file must refuse the run, not be skipped')
  assert.match(outcome.run.detail, /could not be read/)
  assert.equal(svc.ledger.rowsFor('session-1')[0].pass, false)
})

test('a descendant the probe backgrounded is torn down before the comparison', async t => {
  const cwd = tempDir(t)
  const victim = path.join(cwd, 'app.js')
  fs.writeFileSync(victim, 'ORIGINAL')
  const marker = path.join(cwd, 'MARKER-FROM-CHILD')
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const child = path.join(os.tmpdir(), `cg-child-${process.pid}-${Date.now()}.mjs`)
  // The child is in the probe's own process group and tries to write well after the probe exits.
  fs.writeFileSync(child, [
    "import fs from 'node:fs'",
    `setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, 'x'); fs.writeFileSync(${JSON.stringify(victim)}, 'CHILDWROTE') }, 2500)`,
    'setTimeout(() => process.exit(0), 4000)',
  ].join('\n') + '\n')
  const script = path.join(os.tmpdir(), `dsh-verify-descendant-${process.pid}-${Date.now()}.mjs`)
  fs.writeFileSync(script, [
    "import { spawn } from 'node:child_process'",
    `spawn(process.execPath, [${JSON.stringify(child)}], { stdio: 'ignore' })`,
    'setTimeout(() => process.exit(0), 400)',
  ].join('\n') + '\n')
  t.after(() => { fs.rmSync(script, { force: true }); fs.rmSync(child, { force: true }) })

  await svc.temporaryVerify(agentFor(cwd), { script_path: script, runtime: 'node' })
  // Wait past the child's write deadline: the group teardown must have already prevented it.
  await new Promise(resolve => setTimeout(resolve, 3000))
  assert.equal(fs.existsSync(marker), false, 'a backgrounded descendant must not survive the run')
  assert.equal(fs.readFileSync(victim, 'utf8'), 'ORIGINAL', 'a backgrounded descendant must not edit the tree')
})

test('an unlistable directory refuses the run instead of hiding an edit', async t => {
  const cwd = tempDir(t)
  const sub = path.join(cwd, 'sub')
  fs.mkdirSync(sub)
  const victim = path.join(sub, 'code.js')
  fs.writeFileSync(victim, 'ORIGINAL')
  // Search but not read permission on the directory: a walk that skipped it would never see the
  // file inside, which is still writable by path.
  fs.chmodSync(sub, 0o111)
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const script = path.join(os.tmpdir(), `dsh-verify-unlistable-${process.pid}-${Date.now()}.mjs`)
  fs.writeFileSync(script, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(victim)}, 'REWRITTEN')\nprocess.exit(0)\n`)
  t.after(() => fs.rmSync(script, { force: true }))
  try {
    const outcome = await svc.temporaryVerify(agentFor(cwd), { script_path: script, runtime: 'node' })
    // The refusal happens on the before-walk, so the probe never runs and the tree is untouched.
    assert.equal(outcome.run.exitCode, null, 'the probe must not be started at all')
    assert.equal(fs.readFileSync(victim, 'utf8'), 'ORIGINAL', 'a refused run leaves the tree alone')
    assert.equal(outcome.run.pass, false, 'an unlistable directory must refuse the run, not hide the edit')
    assert.match(outcome.run.detail, /directory could not be listed/)
    assert.equal(svc.ledger.rowsFor('session-1')[0].pass, false)
  } finally {
    // Restored here rather than in an after hook: the directory cleanup registered by tempDir runs
    // first, and it cannot recurse into a directory that denies read permission.
    fs.chmodSync(sub, 0o755)
  }
})

test('a permission-only or symlink-only change is detected', async t => {
  const cwd = tempDir(t)
  const scriptFile = path.join(cwd, 'run.sh')
  fs.writeFileSync(scriptFile, '#!/bin/sh\n')
  fs.chmodSync(scriptFile, 0o644)
  const link = path.join(cwd, 'current')
  fs.symlinkSync('run.sh', link)
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const probe = path.join(os.tmpdir(), `dsh-verify-mode-${process.pid}-${Date.now()}.mjs`)

  // Flipping the executable bit changes how the project runs but no file's contents.
  fs.writeFileSync(probe, `import fs from 'node:fs'\nfs.chmodSync(${JSON.stringify(scriptFile)}, 0o755)\nprocess.exit(0)\n`)
  t.after(() => fs.rmSync(probe, { force: true }))
  const modeOutcome = await svc.temporaryVerify(agentFor(cwd), { script_path: probe, runtime: 'node' })
  assert.equal(modeOutcome.run.mutatedRepository, true, 'a permission change must be detected')

  // Retargeting a symlink changes what the project resolves, with no content change anywhere.
  fs.writeFileSync(probe, [
    "import fs from 'node:fs'",
    `fs.unlinkSync(${JSON.stringify(link)})`,
    `fs.symlinkSync('other.sh', ${JSON.stringify(link)})`,
    'process.exit(0)',
  ].join('\n') + '\n')
  const linkOutcome = await svc.temporaryVerify(agentFor(cwd), { script_path: probe, runtime: 'node' })
  assert.equal(linkOutcome.run.mutatedRepository, true, 'a retargeted symlink must be detected')
})

test('writing different bytes and restoring the original ones is still detected', async t => {
  const cwd = tempDir(t)
  const victim = path.join(cwd, 'app.js')
  fs.writeFileSync(victim, 'ORIGINAL-CONTENT')
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const script = path.join(os.tmpdir(), `dsh-verify-restore-${process.pid}-${Date.now()}.mjs`)
  // The probe tampers mid-run and puts the exact original bytes back before exiting, so the final
  // content equals the starting content. The modification time is what exposes it.
  fs.writeFileSync(script, [
    "import fs from 'node:fs'",
    `const p = ${JSON.stringify(victim)}`,
    'const original = fs.readFileSync(p)',
    "fs.writeFileSync(p, 'TAMPERED-DURING-RUN')",
    'fs.writeFileSync(p, original)',
    'process.exit(0)',
  ].join('\n') + '\n')
  t.after(() => fs.rmSync(script, { force: true }))

  const outcome = await svc.temporaryVerify(agentFor(cwd), { script_path: script, runtime: 'node' })
  assert.equal(fs.readFileSync(victim, 'utf8'), 'ORIGINAL-CONTENT', 'precondition: content was restored')
  assert.equal(outcome.run.mutatedRepository, true, 'a mid-run write must be detected even if content is restored')
})

test('a new empty directory, a skipped-name symlink and a FIFO are each detected', async t => {
  const cwd = tempDir(t)
  fs.writeFileSync(path.join(cwd, 'app.js'), 'x')
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const probe = path.join(os.tmpdir(), `dsh-verify-entries-${process.pid}-${Date.now()}.mjs`)
  t.after(() => fs.rmSync(probe, { force: true }))
  const run = body => { fs.writeFileSync(probe, body); return svc.temporaryVerify(agentFor(cwd), { script_path: probe, runtime: 'node' }) }

  // An empty directory adds nothing to a file-content-only walk.
  const dirOutcome = await run(`import fs from 'node:fs'\nfs.mkdirSync(${JSON.stringify(path.join(cwd, 'newdir'))})\nprocess.exit(0)\n`)
  assert.equal(dirOutcome.run.mutatedRepository, true, 'creating a directory must be detected')

  // A symlink whose name is in the skip set must still be fingerprinted as a symlink.
  const modules = path.join(cwd, 'node_modules')
  fs.mkdirSync(modules)
  const linkOutcome = await run([
    "import fs from 'node:fs'",
    `fs.rmSync(${JSON.stringify(modules)}, { recursive: true, force: true })`,
    `fs.symlinkSync('/etc/hostname', ${JSON.stringify(modules)})`,
    'process.exit(0)',
  ].join('\n') + '\n')
  assert.equal(linkOutcome.run.mutatedRepository, true, 'a symlink named node_modules must be fingerprinted')

  // An entry type the comparison cannot describe is refused rather than ignored.
  const fifo = path.join(cwd, 'pipe')
  const fifoOutcome = await run(`import { execFileSync } from 'node:child_process'\nexecFileSync('mkfifo', [${JSON.stringify(fifo)}])\nprocess.exit(0)\n`)
  assert.equal(fifoOutcome.run.pass, false, 'an undescribable entry type must refuse the run')
  assert.match(fifoOutcome.run.detail, /neither a file, a directory nor a symlink/)
})

test('the entry cap counts symlinks, not only regular files', async t => {
  const cwd = tempDir(t)
  // Only symlinks beyond the cap: a cap that counted regular files alone would report a digest.
  for (let i = 0; i < 5001; i += 1) fs.symlinkSync('/etc/hostname', path.join(cwd, `l${String(i).padStart(5, '0')}`))
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const script = path.join(os.tmpdir(), `dsh-verify-linkcap-${process.pid}-${Date.now()}.mjs`)
  fs.writeFileSync(script, 'process.exit(0)\n')
  t.after(() => fs.rmSync(script, { force: true }))

  const outcome = await svc.temporaryVerify(agentFor(cwd), { script_path: script, runtime: 'node' })
  assert.equal(outcome.run.pass, false, 'a workspace of symlinks past the cap must be refused')
  assert.match(outcome.run.detail, /more than 5000 entries/)
})

test('a failing temporary script is left on disk for repair', async t => {
  const cwd = tempDir(t)
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const script = path.join(os.tmpdir(), `dsh-verify-fail-${process.pid}-${Date.now()}.mjs`)
  fs.writeFileSync(script, 'console.error("nope"); process.exit(3)\n')
  t.after(() => fs.rmSync(script, { force: true }))

  const outcome = await svc.temporaryVerify(agentFor(cwd), { script_path: script, runtime: 'node' })
  assert.equal(outcome.run.pass, false)
  assert.equal(fs.existsSync(script), true, 'a failing script is left so it can be repaired')
  assert.equal(svc.ledger.rowsFor('session-1')[0].pass, false)
})

test('a temporary script that changes repository state is rejected', async t => {
  const cwd = tempDir(t)
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const script = path.join(os.tmpdir(), `dsh-verify-mutate-${process.pid}-${Date.now()}.mjs`)
  // The script edits the very code it is testing, which must be rejected even though it exits 0.
  fs.writeFileSync(script, `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(path.join(cwd, 'app.js'))}, 'sneaky = true\\n')\nprocess.exit(0)\n`)
  t.after(() => fs.rmSync(script, { force: true }))

  const outcome = await svc.temporaryVerify(agentFor(cwd), { script_path: script, runtime: 'node' })
  assert.equal(outcome.run.exitCode, 0, 'precondition: the script itself succeeded')
  assert.equal(outcome.run.mutatedRepository, true)
  assert.equal(outcome.run.pass, false, 'changing repository state must reject the probe')
  assert.match(outcome.run.detail, /changed repository state/)
})

test('the temporary verifier refuses when a canonical check exists', async t => {
  const cwd = tempDir(t)
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'has-test', scripts: { test: 'node -e ""' } }))
  const svc = service(t, { cwd, settings: { requireAttestation: false, allowTemporaryVerifier: true } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const script = path.join(os.tmpdir(), `dsh-verify-refuse-${process.pid}-${Date.now()}.mjs`)
  fs.writeFileSync(script, 'process.exit(0)\n')
  t.after(() => fs.rmSync(script, { force: true }))
  const outcome = await svc.temporaryVerify(agentFor(cwd), { script_path: script, runtime: 'node' })
  assert.equal(outcome.ok, false)
  assert.match(outcome.blockers.join(' '), /canonical check exists/)
  assert.equal(fs.existsSync(script), true, 'a refused script is never deleted')
})

test('verification nudges are bounded per change record and the override still clears a block', async t => {
  const cwd = tempDir(t)
  const svc = service(t, { cwd, settings: { verificationNudgeLimit: 2, requireTests: true, requireAttestation: true, mode: 'strict' } })
  announce(svc, 'session-1', 1, 10, [file('app.js')])
  const agent = agentFor(cwd)
  for (let i = 0; i < 3; i += 1) await svc.stopping({ agent, turn: 1, signal: new AbortController().signal })
  assert.equal(agent.steers.length, 3)
  assert.match(agent.steers[0].content[0].text, /COMPLETION GATE BLOCKED/)
  assert.match(agent.steers[2].content[0].text, /STILL BLOCKED.*3 checks/s, 'past the bound the long instruction is not repeated')

  const overridden = await svc.override(agent, 'operator reviewed')
  assert.equal(overridden.pass, true, 'the explicit human override still clears a block')
  assert.equal(overridden.overridden, true)
})

test('the operator override waives every blocker class and leaves the waiver auditable', async t => {
  // A failed REQUIRED check is a hard blocker: no other evidence in the gate can cover it, so an
  // override here is the strongest form of the claim that an override bypasses hard blockers.
  // User story 31 requires this ("a blocked agent is never without a way forward"), and the
  // waiver must stay visible rather than become a silent pass.
  const hard = tempDir(t)
  fs.writeFileSync(path.join(hard, 'package.json'), JSON.stringify({ name: 'failing', scripts: { test: 'node -e "process.exit(1)"' } }))
  const hardSvc = service(t, { cwd: hard, settings: { requireAttestation: false, requireTests: true, mode: 'strict' } })
  announce(hardSvc, 'session-1', 1, 10, [file('app.js')])
  const before = await hardSvc.run(agentFor(hard), new AbortController().signal, { force: true })
  assert.equal(before.pass, false, 'precondition: the failing required check blocks')
  assert.deepEqual(before.blockers, ['Node test: test failed.'])

  const hardAgent = agentFor(hard)
  const waived = await hardSvc.override(hardAgent, 'operator accepted the failing suite')
  assert.equal(waived.pass, true, 'the explicit human override still clears a hard blocker')
  assert.equal(waived.overridden, true)
  assert.deepEqual(waived.blockers, ['Node test: test failed.'], 'the waived blocker stays listed in the report')
  assert.equal(hardSvc.state(hardAgent).override.reason, 'operator accepted the failing suite', 'the operator reason is recorded')

  // An undetermined change record carries no files, so the override is bound to a fingerprint
  // over an empty changed set. It still clears the block, which is the same "way forward"
  // guarantee; the reason that is safe is that the waived blocker stays in the report.
  const undetermined = tempDir(t)
  const undetSvc = service(t, { cwd: undetermined, settings: { requireAttestation: false, requireTests: false, mode: 'strict' }, workspaceChanges: null })
  const undetAgent = agentFor(undetermined)
  assert.equal((await undetSvc.turnChanges(undetAgent)).determined, false, 'precondition: the change set is undetermined')
  const blocked = await undetSvc.run(undetAgent, new AbortController().signal, { force: true })
  assert.equal(blocked.pass, false, 'precondition: the undetermined record blocks')
  const cleared = await undetSvc.override(undetAgent, 'operator accepted the undetermined record')
  assert.equal(cleared.pass, true, 'the override also clears an undetermined change record')
  assert.match(cleared.blockers.join(' '), /cannot be determined/, 'the waived blocker stays listed in the report')

  // The waiver is bound to one change record: a later turn that changes another file must not
  // inherit it, so the escape hatch cannot silently cover work the operator never saw.
  announce(hardSvc, 'session-1', 2, 20, [file('app.js'), file('other.js')])
  const later = await hardSvc.run(hardAgent, new AbortController().signal, { force: true })
  assert.equal(later.overridden, false, 'the override does not carry to a later change record')
  assert.equal(later.pass, false)
})
