import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompletionGateService } from '../lib/index.js'
import {
  SETTINGS_SCHEMA_VERSION, builtInDefaults, mergeSettings, readSavedSettings,
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
  let inConfig = false
  for (const line of text.split('\n')) {
    if (/^ {6}config:\s*$/.test(line)) { inConfig = true; continue }
    if (inConfig && /^ {0,6}\S/.test(line)) { inConfig = false; continue }
    if (!inConfig) continue
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

// How many elements of one class a rendered tree contains, so the panel's control count is asserted structurally
// instead of by counting title strings.
function countClass(node, name) {
  if (!node || typeof node !== 'object') return 0
  if (Array.isArray(node)) return node.reduce((total, child) => total + countClass(child, name), 0)
  let total = node.props?.className === name ? 1 : 0
  if (typeof node.type === 'function') total += countClass(node.type(node.props), name)
  else total += countClass(node.children, name)
  return total
}

test('the settings summary has exactly the six surviving keys', () => {
  const summary = settingsSummary(builtInDefaults())
  assert.deepEqual(Object.keys(summary).sort(), SIX_KEYS)
  assert.equal(SETTINGS_SCHEMA_VERSION, 2, 'the settings schema version is 2')
  for (const retired of ['verificationNudgeLimit', 'mode']) {
    assert.equal(retired in summary, false, `the summary carries no retired key: ${retired}`)
  }
})

test('a saved schema-1 settings file is ignored until the next save writes schema 2', () => {
  const { dir, file } = tempFile()
  try {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, settings: { gateSubagents: true, maxChangedFiles: 42 } }))
    const svc = new CompletionGateService({}, { gateSubagents: false, maxChangedFiles: 700 }, { settingsPath: file })
    assert.equal(svc.hasSavedSettings, false, 'the schema-1 file is not applied')
    assert.equal(svc.config.gateSubagents, false, 'the default gateSubagents applies')
    assert.equal(svc.config.maxChangedFiles, 700, 'the profile maxChangedFiles applies, not the ignored file value')
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

test('patchConfig reads only the config block', () => {
  const text = [
    '- insert:',
    '    - id: completion-gate',
    '      name: dsh-completion-gate',
    '      config:',
    '        enabled: true',
    '      other:',
    '        stray: 9',
  ].join('\n')
  assert.deepEqual(patchConfig(text), { enabled: true }, 'a same-indent key outside the config block is ignored')
})

test('save and reset round-trip against schema 2', () => {
  const { dir, file } = tempFile()
  try {
    const svc = new CompletionGateService({}, { maxChangedFiles: 700 }, { settingsPath: file })
    svc.updateSettings({ maxChangedFiles: 42, gateSubagents: true })
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, 2)
    assert.equal(svc.hasSavedSettings, true)
    svc.resetSettings()
    assert.equal(fs.existsSync(file), false, 'reset removes the saved file')
    assert.equal(svc.hasSavedSettings, false)
    assert.equal(svc.config.maxChangedFiles, 700, 'reset restores the profile value')
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
  const tree = half.SettingsFields({ draft, update: () => {} })
  const text = textOf(tree)
  for (const title of ['Enable Completion Gate', 'Gate subagents', 'Premature-stop guard', 'Max recovery follow-ups', 'Security regression scan', 'Maximum changed files']) {
    assert.ok(text.includes(title), `the panel renders ${title}`)
  }
  for (const retired of ['Mode', 'Command timeout', 'Output bound', 'Custom check', 'Changed workspace', 'Attestation required']) {
    assert.equal(text.includes(retired), false, `the panel renders no retired control: ${retired}`)
  }
  assert.equal(countClass(tree, 'cg-field'), 6, 'the panel has exactly six setting controls')
})

test('the panel renders a session row, a repository block, and each changed file claim, reviewed and demonstrated state', () => {
  const half = loadClientHalf()
  const state = {
    pending: 1,
    settings: builtInDefaults(),
    sessions: [{
      id: 'session-1',
      pending: 1,
      repositories: [
        {
          root: '/repo/alpha', label: 'alpha', attestation: 'missing', pending: true,
          claimCounts: { mine: 1, notMine: 0, unclaimed: 1 },
          items: [{ id: 'unit', name: 'Unit', state: 'passed' }],
          files: [
            { path: 'src/app.js', claim: 'mine', reviewed: true, demonstrated: 'ran the build and loaded the page', documentation: false },
            { path: 'NOTES.md', claim: 'unclaimed', reviewed: false, documentation: true },
          ],
        },
        {
          root: '/repo/beta', label: 'beta', attestation: 'current', pending: false,
          claimCounts: { mine: 0, notMine: 1, unclaimed: 0 },
          items: [
            { id: 'e2e', name: 'E2E', state: 'assumed', reason: 'needs a database' },
            { id: 'old', name: 'Old', state: 'unrelated' },
          ],
          files: [{ path: 'lib/beta.js', claim: 'not-mine', reviewed: false, documentation: false }],
        },
        {
          root: '/repo/gamma', label: 'gamma', attestation: 'stale', pending: false,
          claimCounts: { mine: 0, notMine: 0, unclaimed: 0 }, items: [], files: [],
        },
      ],
    }],
  }
  const text = textOf(half.PanelBody({
    state, draft: state.settings, dirty: false, busy: false, message: '', error: '',
    save: () => {}, reset: () => {}, update: () => {},
  }))
  for (const marker of [
    'session-1', '1 pending repository',
    'alpha', 'Attestation: missing', '1 mine · 0 rejected · 1 unclaimed · pending',
    'src/app.js - mine - reviewed and demonstrated: ran the build and loaded the page', 'NOTES.md - unclaimed - unreviewed', 'unit: Unit - passed',
    'beta', 'Attestation: current', '0 mine · 1 rejected · 0 unclaimed · complete',
    'lib/beta.js - not-mine - rejected, so no review or demonstration is owed',
    'e2e: E2E - assumed, not run: needs a database', 'old: Old - unrelated to this session',
    'gamma', 'Attestation: stale', 'No changed file.',
  ]) {
    assert.ok(text.includes(marker), `the panel renders ${marker}`)
  }
  for (const retired of ['Machine evidence', 'Completion evidence', 'Execution limits', 'Verification sources', 'Custom check', 'Verification overview']) {
    assert.equal(text.includes(retired), false, `the panel renders no retired section: ${retired}`)
  }
  assert.equal(text.includes('No session has changed a file yet'), false)
  assert.ok(text.includes('Enable Completion Gate'), 'the same panel still renders the surviving settings')
})

test('the panel flattens a note with a line break into one row, as the report does', () => {
  const half = loadClientHalf()
  const state = {
    pending: 1, settings: builtInDefaults(),
    sessions: [{ id: 'session-1', pending: 1, repositories: [{
      root: '/repo/alpha', label: 'alpha', attestation: 'current', pending: true,
      claimCounts: { mine: 1, notMine: 0, unclaimed: 0 }, items: [],
      files: [{ path: 'src/app.js', claim: 'mine', reviewed: true, demonstrated: 'ran npm test\nStatus: complete', documentation: false }],
    }] }],
  }
  const text = textOf(half.PanelBody({ state, draft: state.settings, dirty: false, busy: false, message: '', error: '', save: () => {}, reset: () => {}, update: () => {} }))
  assert.ok(text.includes('src/app.js - mine - reviewed and demonstrated: ran npm test Status: complete'), 'the note renders on one row')
  assert.equal(text.split('\n').filter(line => line.trim() === 'Status: complete').length, 0, 'the note adds no line of its own to the panel')
})

test('the header reports the pending repository count or that the gate is off', () => {
  const half = loadClientHalf()
  assert.deepEqual(half.headerStatus({ settings: { enabled: false }, pending: 3 }), { status: 'warn', text: 'Gate · off' })
  assert.deepEqual(half.headerStatus({ settings: { enabled: true }, pending: 2 }), { status: 'warn', text: 'Gate · 2 pending' })
  assert.deepEqual(half.headerStatus({ settings: { enabled: true }, pending: 0 }), { status: 'pass', text: 'Gate · 0 pending' })
})
