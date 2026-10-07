import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompletionGateService } from '../lib/index.js'
import { VerificationLedger, ledgerRow } from '../lib/ledger.js'

const row = (over = {}) => ledgerRow({ source: 'recipe', name: 'node', scope: 'full', pass: true, fingerprint: 'fp-A', turn: 3, seq: 305, ...over })

test('a recorded pass carries its source, scope, status, output and change record', () => {
  const ledger = new VerificationLedger()
  const recorded = ledger.record('s1', ledgerRow({ source: 'recipe', name: 'next', kind: 'nextjs', scope: 'full', pass: true, turn: 4, seq: 40, fingerprint: 'fp-A', output: 'ok' }))
  assert.deepEqual(
    { source: recorded.source, name: recorded.name, kind: recorded.kind, scope: recorded.scope, pass: recorded.pass, turn: recorded.turn, seq: recorded.seq, fingerprint: recorded.fingerprint, output: recorded.output },
    { source: 'recipe', name: 'next', kind: 'nextjs', scope: 'full', pass: true, turn: 4, seq: 40, fingerprint: 'fp-A', output: 'ok' },
  )
  assert.equal(typeof recorded.recordedAt, 'number')
})

test('a pass is fresh for its own change record and stale after a later one', () => {
  const ledger = new VerificationLedger()
  ledger.record('s1', row({ fingerprint: 'fp-1' }))
  assert.equal(ledger.satisfied('s1', 'fp-1'), true, 'fresh for the record it was earned against')
  assert.equal(ledger.satisfied('s1', 'fp-2'), false, 'a later change record makes it stale')
  assert.equal(ledger.summary('s1', 'fp-2').fresh, 0)
  assert.equal(ledger.summary('s1', 'fp-2').total, 1, 'a stale row is kept, not deleted')
})

// A targeted pass is fresh evidence, exactly as in Hermes, whose ledger stores the same label
// and never branches on it. This is the regression test for the last-resort path: gating on
// scope === 'full' left the temporary verifier unable to clear the missing-harness blocker,
// because that path always records targeted.
test('a targeted pass satisfies the requirement while still being recorded as targeted', () => {
  const ledger = new VerificationLedger()
  const recorded = ledger.record('s1', row({ scope: 'targeted', fingerprint: 'fp-1' }))
  assert.equal(recorded.scope, 'targeted', 'the honest scope label is kept for the record')
  assert.equal(ledger.satisfied('s1', 'fp-1'), true, 'a fresh targeted pass satisfies the requirement')
  assert.equal(ledger.summary('s1', 'fp-1').satisfied, true)
})

test('a failing run is recorded as a failure and does not satisfy the requirement', () => {
  const ledger = new VerificationLedger()
  ledger.record('s1', row({ pass: false, output: 'AssertionError: boom' }))
  assert.equal(ledger.satisfied('s1', 'fp-A'), false)
  assert.equal(ledger.latest('s1').output, 'AssertionError: boom', 'the failure keeps its bounded output')
})

test('rows are per session and resetting evidence discards every row', () => {
  const ledger = new VerificationLedger()
  ledger.record('s1', row({ fingerprint: 'fp-A' }))
  ledger.record('s2', row({ fingerprint: 'fp-B' }))
  assert.equal(ledger.rowsFor('s1').length, 1)
  assert.equal(ledger.rowsFor('s2').length, 1)
  assert.equal(ledger.satisfied('s2', 'fp-A'), false, 'one session cannot spend another session evidence')
  ledger.clear('s1')
  assert.deepEqual(ledger.rowsFor('s1'), [])
  assert.equal(ledger.rowsFor('s2').length, 1, 'only the named session is cleared')
  ledger.clearAll()
  assert.equal(ledger.rowsFor('s2').length, 0)
})

test('changing gate policy discards recorded verification evidence', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ledger-policy-')))
  const ctx = { reflect: { get: () => undefined } }
  const svc = new CompletionGateService(ctx, {}, { settingsPath: path.join(dir, 'settings.json') })
  try {
    svc.ledger.record('s1', row({ fingerprint: 'fp-A' }))
    svc.ledger.record('s1', row({ fingerprint: 'fp-A' }))
    assert.equal(svc.ledger.rowsFor('s1').length, 2)
    svc.updateSettings({ securityScan: false })
    assert.equal(svc.ledger.rowsFor('s1').length, 0, 'a pass earned under different rules must not be reused')
    svc.ledger.record('s1', row({ fingerprint: 'fp-A' }))
    svc.resetSettings()
    assert.equal(svc.ledger.rowsFor('s1').length, 0)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('freshness does not depend on any repository content hash', () => {
  const ledger = new VerificationLedger()
  ledger.record('s1', row({ fingerprint: 'record-identity' }))
  assert.equal(ledger.satisfied('s1', 'record-identity'), true)
  // Nothing about the working tree is consulted: an identical identity stays fresh even
  // though files were written outside the gate's view, and a changed identity is stale even
  // when every file is byte-identical.
  assert.equal(ledger.satisfied('s1', 'other-identity'), false)
})

test('resetting session evidence discards every recorded verification row', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ledger-reset-')))
  const ctx = { reflect: { get: () => undefined } }
  const svc = new CompletionGateService(ctx, {}, { settingsPath: path.join(dir, 'settings.json') })
  try {
    const agent = { id: 'session-1', session: { header: { cwd: dir }, events: [] } }
    svc.ledger.record('session-1', row({ fingerprint: 'fp-A' }))
    svc.ledger.record('session-1', row({ fingerprint: 'fp-A' }))
    assert.equal(svc.ledger.satisfied('session-1', 'fp-A'), true)
    svc.reset(agent)
    assert.equal(svc.ledger.rowsFor('session-1').length, 0, 'a reset must discard every recorded row')
    assert.equal(svc.ledger.satisfied('session-1', 'fp-A'), false, 'a discarded pass cannot still satisfy the requirement')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
