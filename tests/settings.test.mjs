import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { builtInDefaults, mergeSettings, readSavedSettings, removeSavedSettings, writeSavedSettings } from '../lib/settings.js'

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-settings-'))
  return { dir, file: path.join(dir, 'settings.json') }
}

test('saved settings round-trip without unrelated fields', () => {
  const { dir, file } = tempFile()
  try {
    const config = { ...builtInDefaults(), mode: 'advisory', requireTests: false, customChecks: [{ name: 'integration', category: 'test', command: 'npm run integration', required: true }] }
    writeSavedSettings(file, config)
    const saved = readSavedSettings(file)
    assert.equal(saved.mode, 'advisory')
    assert.equal(saved.requireTests, false)
    assert.equal(saved.customChecks[0].command, 'npm run integration')
    const wire = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(wire, /settingsPath|homedir|cwd/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('saved UI overlay wins over profile config and reset file removal is safe', () => {
  const profile = { ...builtInDefaults(), mode: 'strict', gateSubagents: false }
  const merged = mergeSettings(profile, { mode: 'advisory', gateSubagents: true })
  assert.equal(merged.mode, 'advisory')
  assert.equal(merged.gateSubagents, true)
  const { dir, file } = tempFile()
  try {
    writeSavedSettings(file, merged)
    assert.equal(removeSavedSettings(file), true)
    assert.equal(removeSavedSettings(file), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the verification-source options round-trip and reset restores their defaults', () => {
  const { dir, file } = tempFile()
  try {
    const defaults = builtInDefaults()
    assert.deepEqual(
      { autoDetectRecipe: defaults.autoDetectRecipe, allowTemporaryVerifier: defaults.allowTemporaryVerifier, recipeReadinessTimeoutMs: defaults.recipeReadinessTimeoutMs, verificationNudgeLimit: defaults.verificationNudgeLimit },
      { autoDetectRecipe: true, allowTemporaryVerifier: true, recipeReadinessTimeoutMs: 60_000, verificationNudgeLimit: 3 },
      'the documented defaults must not drift',
    )
    writeSavedSettings(file, { ...defaults, autoDetectRecipe: false, allowTemporaryVerifier: false, recipeReadinessTimeoutMs: 5_000, verificationNudgeLimit: 1 })
    const saved = readSavedSettings(file)
    assert.equal(saved.autoDetectRecipe, false)
    assert.equal(saved.allowTemporaryVerifier, false)
    assert.equal(saved.recipeReadinessTimeoutMs, 5_000)
    assert.equal(saved.verificationNudgeLimit, 1)
    // A saved overlay wins over the profile value, exactly like the pre-existing options.
    const merged = mergeSettings({ ...defaults, autoDetectRecipe: true }, saved)
    assert.equal(merged.autoDetectRecipe, false)
    assert.equal(merged.verificationNudgeLimit, 1)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
