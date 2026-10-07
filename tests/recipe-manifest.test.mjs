import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RECIPE_MANIFEST_VERSION, detectRecipe, loadManifest, manifestPath, normalizeRecipe, resolveRecipe, saveManifest } from '../lib/recipe.js'

function make(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recipe-manifest-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

function writeManifest(dir, payload) {
  const file = manifestPath(dir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload))
  return file
}

const NODE_PROJECT = { 'package.json': { name: 'x', scripts: { test: 'node --test' }, dependencies: { vite: '1' } } }

test('no manifest is not a problem and detection still answers', t => {
  const dir = make(t, NODE_PROJECT)
  assert.deepEqual(loadManifest(dir), { recipe: null, problem: null })
  const resolved = resolveRecipe(dir)
  assert.equal(resolved.source, 'detected')
  assert.equal(resolved.recipe.kind, 'vite')
  assert.deepEqual(resolved.problems, [])
})

test('a saved manifest wins over detection and is returned unchanged', t => {
  const dir = make(t, NODE_PROJECT)
  const saved = normalizeRecipe({ name: 'Hand written', kind: 'custom', bootstrap: ['make deps'], test: ['make verify'], start: 'make serve', port: 9090, readinessPath: '/healthz', evidence: ['operator note'] })
  saveManifest(dir, saved)
  const loaded = loadManifest(dir)
  assert.deepEqual(loaded, { recipe: saved, problem: null })
  const resolved = resolveRecipe(dir)
  assert.equal(resolved.source, 'manifest')
  assert.deepEqual(resolved.recipe, saved)
  // The detected Vite values (port 5173, npm run test) must not leak into the saved recipe.
  assert.notEqual(resolved.recipe.port, 5173)
  assert.deepEqual(resolved.recipe.test, ['make verify'])
})

test('saving the detected recipe writes a manifest a later run loads as saved', t => {
  const dir = make(t, NODE_PROJECT)
  const detected = resolveRecipe(dir)
  assert.equal(detected.source, 'detected')
  saveManifest(dir, detected.recipe)
  const written = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'))
  assert.equal(written.version, RECIPE_MANIFEST_VERSION)
  assert.deepEqual(written.recipe, detected.recipe)
  const reloaded = resolveRecipe(dir)
  assert.equal(reloaded.source, 'manifest')
  assert.deepEqual(reloaded.recipe, detected.recipe)
  // A second save of the same recipe is stable.
  saveManifest(dir, reloaded.recipe)
  assert.deepEqual(loadManifest(dir).recipe, detected.recipe)
})

test('an unparseable manifest falls back to detection and reports the problem', t => {
  const dir = make(t, NODE_PROJECT)
  writeManifest(dir, '{ this is not json')
  const loaded = loadManifest(dir)
  assert.equal(loaded.recipe, null)
  assert.match(loaded.problem, /not valid JSON/)
  const resolved = resolveRecipe(dir)
  assert.equal(resolved.source, 'detected')
  assert.equal(resolved.recipe.kind, 'vite')
  assert.deepEqual(resolved.problems, [loaded.problem])
})

test('a wrong-shape manifest falls back to detection and reports the problem', t => {
  for (const payload of [['a', 'b'], { version: 1, recipe: {} }, { version: 2, recipe: { name: 'x' } }, { recipe: { name: 'x' } }]) {
    const dir = make(t, NODE_PROJECT)
    writeManifest(dir, payload)
    const loaded = loadManifest(dir)
    const label = JSON.stringify(payload)
    assert.equal(loaded.recipe, null, label)
    assert.match(loaded.problem, /Falling back to detection/, label)
    assert.equal(resolveRecipe(dir).source, 'detected', label)
  }
})

test('an unreadable manifest path reports a problem instead of throwing', t => {
  const dir = make(t, NODE_PROJECT)
  fs.mkdirSync(manifestPath(dir), { recursive: true })
  const loaded = loadManifest(dir)
  assert.equal(loaded.recipe, null)
  assert.match(loaded.problem, /could not be read/)
  assert.equal(resolveRecipe(dir).source, 'detected')
})

test('a saved empty recipe is detection-free but still reported as a problem', t => {
  const dir = make(t, NODE_PROJECT)
  saveManifest(dir, { name: 'Only bootstrap', bootstrap: ['npm install'] })
  const resolved = resolveRecipe(dir)
  assert.equal(resolved.source, 'manifest')
  assert.deepEqual(resolved.recipe.bootstrap, ['npm install'])
  assert.deepEqual(resolved.problems, [])
})

test('saveManifest refuses a recipe without a name', t => {
  const dir = make(t)
  assert.throws(() => saveManifest(dir, { kind: 'node' }), /requires a recipe with a name/)
  assert.equal(fs.existsSync(manifestPath(dir)), false)
})

test('detectRecipe agrees with resolveRecipe when no manifest exists', t => {
  const dir = make(t, NODE_PROJECT)
  assert.deepEqual(detectRecipe(dir), resolveRecipe(dir).recipe)
})
