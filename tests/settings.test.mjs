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
    const config = { ...builtInDefaults(), gateSubagents: true, maxChangedFiles: 42 }
    writeSavedSettings(file, config)
    const saved = readSavedSettings(file)
    assert.equal(saved.gateSubagents, true)
    assert.equal(saved.maxChangedFiles, 42)
    const wire = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(wire, /settingsPath|homedir|cwd/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('saved UI overlay wins over profile config and reset file removal is safe', () => {
  const profile = { ...builtInDefaults(), maxChangedFiles: 500, gateSubagents: false }
  const merged = mergeSettings(profile, { maxChangedFiles: 42, gateSubagents: true })
  assert.equal(merged.maxChangedFiles, 42)
  assert.equal(merged.gateSubagents, true)
  const { dir, file } = tempFile()
  try {
    writeSavedSettings(file, merged)
    assert.equal(removeSavedSettings(file), true)
    assert.equal(removeSavedSettings(file), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('verificationNudgeLimit round-trips and a saved overlay wins over the profile value', () => {
  const { dir, file } = tempFile()
  try {
    const defaults = builtInDefaults()
    assert.equal(defaults.verificationNudgeLimit, 3, 'the documented default must not drift')
    writeSavedSettings(file, { ...defaults, verificationNudgeLimit: 1 })
    const saved = readSavedSettings(file)
    assert.equal(saved.verificationNudgeLimit, 1)
    const merged = mergeSettings({ ...defaults, verificationNudgeLimit: 2 }, saved)
    assert.equal(merged.verificationNudgeLimit, 1)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
