import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONFIG, cleanText, resolveConfig } from './core.js'

export const SETTINGS_SCHEMA_VERSION = 1

const EDITABLE_KEYS = Object.freeze([
  'enabled', 'mode', 'gateSubagents', 'preventPrematureStops', 'prematureStopMaxContinuations',
  'autoDetectChecks', 'requireTests', 'requireBuildWhenAvailable', 'requireLintWhenAvailable',
  'requireTypecheckWhenAvailable', 'blockNewTodos', 'securityScan', 'requireAttestation',
  'gateOnlyChangedWorkspaces', 'commandTimeoutMs', 'maxOutputChars', 'maxChangedFiles',
  'autoDetectRecipe', 'allowTemporaryVerifier', 'recipeReadinessTimeoutMs', 'verificationNudgeLimit',
  'customChecks',
])

export function defaultSettingsPath() {
  const base = process.env.DSH_STATE_HOME || path.join(os.homedir(), '.dsh', 'state')
  return path.join(base, 'dsh-completion-gate.json')
}

export function editableConfig(config) {
  const resolved = resolveConfig(config)
  const out = {}
  for (const key of EDITABLE_KEYS) out[key] = resolved[key]
  return out
}

export function sanitizeSettingsPatch(input = {}) {
  const out = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  for (const key of EDITABLE_KEYS) if (Object.hasOwn(input, key)) out[key] = input[key]
  return out
}

export function readSavedSettings(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    if (data.schemaVersion !== SETTINGS_SCHEMA_VERSION) return null
    return sanitizeSettingsPatch(data.settings)
  } catch { return null }
}

export function writeSavedSettings(file, settings) {
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true })
  const payload = JSON.stringify({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    settings: editableConfig(settings),
    updatedAt: new Date().toISOString(),
  }, null, 2) + '\n'
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 })
  try { fs.renameSync(temp, file) }
  catch (error) {
    // Windows can reject rename-over-existing even though POSIX replaces atomically.
    // Fall back to remove + rename while keeping the complete temp file until the
    // destination has been removed successfully.
    try {
      if (process.platform === 'win32' && fs.existsSync(file)) { fs.rmSync(file, { force: true }); fs.renameSync(temp, file); return }
    } catch {}
    try { fs.unlinkSync(temp) } catch {}
    throw error
  }
}

export function removeSavedSettings(file) {
  try { fs.unlinkSync(file); return true }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}

export function mergeSettings(profileConfig, saved) {
  return resolveConfig({ ...editableConfig(profileConfig), ...(saved || {}) })
}

export function settingsSummary(config) {
  const c = editableConfig(config)
  return {
    ...c,
    customChecks: c.customChecks.map(check => ({
      name: cleanText(check.name, 80),
      category: cleanText(check.category || 'custom', 40),
      command: cleanText(check.command, 2000),
      required: check.required !== false,
    })),
  }
}

export function builtInDefaults() { return editableConfig(DEFAULT_CONFIG) }
