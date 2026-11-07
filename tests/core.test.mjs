import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, resolveConfig, scanSecurity, addedLinesFromDiff } from '../lib/core.js'

test('hotfix defaults are safe', () => {
  const c = resolveConfig({})
  assert.equal(c.gateSubagents, false)
  assert.equal(c.preventPrematureStops, true)
  assert.equal(c.prematureStopMaxContinuations, 3)
})

test('resolveConfig clamps the numeric keys into their ranges', () => {
  const c = resolveConfig({ maxChangedFiles: 1, prematureStopMaxContinuations: -4, securityScan: 'yes' })
  assert.equal(c.maxChangedFiles, 10)
  assert.equal(c.securityScan, true, 'a non-boolean falls back to the default')
  assert.equal(c.prematureStopMaxContinuations, 0)
})

test('resolveConfig takes a boolean as given and falls back to the default for anything else', () => {
  assert.equal(resolveConfig({ securityScan: false }).securityScan, false)
  assert.equal(resolveConfig({ securityScan: 'no' }).securityScan, DEFAULT_CONFIG.securityScan)
})

test('scanSecurity names a hard-coded credential on its line and passes clean code', () => {
  const hits = scanSecurity(['const password = "123456789"', 'const value = 1'])
  assert.deepEqual(hits.map(hit => [hit.id, hit.line]), [['hardcoded-secret', 1]])
  assert.equal(scanSecurity(['const value = 1']).length, 0)
})

test('addedLinesFromDiff keeps only added lines and strips exactly one prefix character', () => {
  assert.deepEqual(addedLinesFromDiff(' context\n-removed\n+added\n+++two plus\n'), ['added', '++two plus'])
})
