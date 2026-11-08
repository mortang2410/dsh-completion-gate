import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompletionGateService } from '../lib/index.js'
import {
  EDITABLE_KEYS, SETTINGS_SCHEMA_VERSION, builtInDefaults, mergeSettings, readSavedSettings,
  removeSavedSettings, settingsSummary, writeSavedSettings,
} from '../lib/settings.js'

const SIX_KEYS = ['enabled', 'gateSubagents', 'maxChangedFiles', 'prematureStopMaxContinuations', 'preventPrematureStops', 'securityScan']
const fixtureRoot = path.join(os.homedir(), 'Trash', '3k74')

function tempFile() {
  fs.mkdirSync(fixtureRoot, { recursive: true })
  const dir = fs.mkdtempSync(path.join(fixtureRoot, 'settings-'))
  return { dir, file: path.join(dir, 'settings.json') }
}

// The config block of the bundle patch, read with the YAML shapes this file uses: a list item, then id, name, and
// config at fixed indents, and one scalar key per line under config. A key outside that block is ignored.
function patchConfig(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const match = /^ {8}([A-Za-z][A-Za-z0-9]*):\s*(\S+)\s*$/.exec(line)
    if (!match) continue
    const [, key, raw] = match
    out[key] = raw === 'true' ? true : raw === 'false' ? false : Number(raw)
  }
  return out
}

// Load the browser half the way the host does, under a minimal React stub whose elements can be flattened to text. The
// stub renders the pure panel components; the hookful Panel itself is not called.
function loadClientHalf() {
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: value => { registration = value } } }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: value => [value, () => {}],
    useEffect: () => {},
    useMemo: fn => fn(),
  }
  const require = specifier => {
    assert.equal(specifier, 'react', `browser half required an unexpected module: ${specifier}`)
    return React
  }
  new Function('window', 'require', source)(window, require)
  assert.ok(registration, 'the browser half never called window.__ModuleLoader__.load')
  return registration.factory(require)
}

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'function') return textOf(node({}))
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return textOf(node.type(node.props))
    return textOf(node.children)
  }
  return ''
}

test('the settings summary has exactly the six surviving keys', () => {
  const summary = settingsSummary(builtInDefaults())
  assert.deepEqual(Object.keys(summary).sort(), SIX_KEYS)
  assert.deepEqual([...EDITABLE_KEYS].sort(), SIX_KEYS, 'the editable key list is the six surviving keys')
  assert.equal(SETTINGS_SCHEMA_VERSION, 2, 'the settings schema version is 2')
  for (const retired of ['verificationNudgeLimit', 'mode']) {
    assert.equal(retired in summary, false, `the summary carries no retired key: ${retired}`)
  }
})

test('a saved schema-1 settings file is ignored until the next save writes schema 2', () => {
  const { dir, file } = tempFile()
  try {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, settings: { gateSubagents: true, maxChangedFiles: 42 } }))
    const svc = new CompletionGateService({}, { gateSubagents: false, maxChangedFiles: 500 }, { settingsPath: file })
    assert.equal(svc.hasSavedSettings, false, 'the schema-1 file is not applied')
    assert.equal(svc.config.gateSubagents, false, 'the default gateSubagents applies')
    assert.equal(svc.config.maxChangedFiles, 500, 'the profile maxChangedFiles applies')
    svc.updateSettings({ maxChangedFiles: 400 })
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(saved.schemaVersion, 2, 'the next save writes schema 2')
    assert.deepEqual(Object.keys(saved.settings).sort(), SIX_KEYS)
    const second = new CompletionGateService({}, {}, { settingsPath: file })
    assert.equal(second.hasSavedSettings, true, 'the schema-2 file is read')
    assert.equal(second.config.maxChangedFiles, 400)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a saved schema-2 settings file is read and a retired key is dropped', () => {
  const { dir, file } = tempFile()
  try {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, settings: { enabled: true, gateSubagents: true, preventPrematureStops: false, prematureStopMaxContinuations: 5, securityScan: false, maxChangedFiles: 42, verificationNudgeLimit: 1 } }))
    const saved = readSavedSettings(file)
    assert.equal(saved.gateSubagents, true)
    assert.equal(saved.maxChangedFiles, 42)
    assert.equal(saved.preventPrematureStops, false)
    assert.equal(saved.securityScan, false)
    assert.equal('verificationNudgeLimit' in saved, false, 'a saved retired key does not survive the read')
    assert.deepEqual(Object.keys(saved).sort(), SIX_KEYS)
    const svc = new CompletionGateService({}, { maxChangedFiles: 500 }, { settingsPath: file })
    assert.equal(svc.hasSavedSettings, true)
    assert.equal(svc.config.maxChangedFiles, 42)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the editable keys, defaults, and bundle patch agree', () => {
  const defaults = builtInDefaults()
  assert.deepEqual(Object.keys(defaults).sort(), SIX_KEYS)
  const patch = fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.deepEqual(patchConfig(patch), defaults, 'the bundle patch carries the surviving defaults')
  assert.doesNotMatch(patch, /verificationNudgeLimit/, 'the bundle patch carries no retired key')
  assert.doesNotMatch(patch, /^\s*mode:/m, 'the bundle patch carries no mode')
})

test('save and reset round-trip against schema 2', () => {
  const { dir, file } = tempFile()
  try {
    const svc = new CompletionGateService({}, { maxChangedFiles: 500 }, { settingsPath: file })
    svc.updateSettings({ maxChangedFiles: 42, gateSubagents: true })
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 2)
    assert.equal(svc.hasSavedSettings, true)
    svc.resetSettings()
    assert.equal(fs.existsSync(file), false, 'reset removes the saved file')
    assert.equal(svc.hasSavedSettings, false)
    assert.equal(svc.config.maxChangedFiles, 500, 'reset restores the profile value')
    assert.equal(svc.config.gateSubagents, false, 'reset restores the default')
    assert.equal(removeSavedSettings(file), false, 'a second removal is safe')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

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
    assert.equal(JSON.parse(wire).schemaVersion, 2)
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

test('the control-center panel renders the six surviving settings and no retired control', () => {
  const half = loadClientHalf()
  const draft = builtInDefaults()
  const text = textOf(half.SettingsFields({ draft, update: () => {} }))
  for (const title of ['Enable Completion Gate', 'Gate subagents', 'Premature-stop guard', 'Max recovery follow-ups', 'Security regression scan', 'Maximum changed files']) {
    assert.ok(text.includes(title), `the panel renders ${title}`)
  }
  for (const retired of ['Mode', 'Command timeout', 'Output bound', 'Custom check', 'Changed workspace', 'Attestation required']) {
    assert.equal(text.includes(retired), false, `the panel renders no retired control: ${retired}`)
  }
})

test('the panel renders a session row, a repository block, and each changed file claim and reviewed state', () => {
  const half = loadClientHalf()
  const state = {
    pending: 1,
    settings: builtInDefaults(),
    sessions: [{
      id: 'session-1',
      pending: 1,
      repositories: [{
        root: '/repo/alpha',
        label: 'alpha',
        attestation: 'missing',
        claimCounts: { mine: 1, notMine: 0, unclaimed: 1 },
        items: [{ id: 'unit', name: 'Unit', state: 'passed' }],
        files: [
          { path: 'src/app.js', claim: 'mine', reviewed: true, documentation: false },
          { path: 'NOTES.md', claim: 'unclaimed', reviewed: false, documentation: true },
        ],
      }],
    }],
  }
  const text = textOf(half.PanelBody({
    state, draft: state.settings, dirty: false, busy: false, message: '', error: '',
    save: () => {}, reset: () => {}, update: () => {},
  }))
  for (const marker of ['session-1', 'alpha', 'src/app.js - mine - reviewed', 'NOTES.md - unclaimed - unreviewed', 'unit', 'passed', 'missing']) {
    assert.ok(text.includes(marker), `the panel renders ${marker}`)
  }
  assert.equal(text.includes('No session has changed a file yet'), false)
  assert.ok(text.includes('Enable Completion Gate'), 'the same panel still renders the surviving settings')
})

test('the header reports the pending repository count or that the gate is off', () => {
  const half = loadClientHalf()
  assert.deepEqual(half.headerStatus({ settings: { enabled: false }, pending: 3 }), { status: 'warn', text: 'Gate · off' })
  assert.deepEqual(half.headerStatus({ settings: { enabled: true }, pending: 2 }), { status: 'warn', text: 'Gate · 2 pending' })
  assert.deepEqual(half.headerStatus({ settings: { enabled: true }, pending: 0 }), { status: 'pass', text: 'Gate · 0 pending' })
})
