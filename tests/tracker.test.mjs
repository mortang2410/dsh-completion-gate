import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDocumentationPath } from '../lib/changes.js'
import { AttestRefusal, RepositoryTracker, attestSchemaErrors, evaluateRepository, planAttest, repositoryDigest } from '../lib/tracker.js'

// Test workspaces live under the task's Trash root, never the system temporary directory (AGENTS.md). The tests never
// delete them, so each run leaves its workspaces in that Trash root for the user to clear.
const workRoot = path.join(os.homedir(), 'Trash', '3t34-tests')

function makeRoot(prefix) {
  fs.mkdirSync(workRoot, { recursive: true })
  return fs.realpathSync(fs.mkdtempSync(path.join(workRoot, prefix)))
}

// A repository snapshot as repositories(sessionId) returns it, built by hand for the pure evaluation tests.
const REPO = '/repo'
function snapshot(overrides = {}) {
  return { root: REPO, label: 'repo', catalogPath: `${REPO}/.dsh/verification.json`, files: [], itemStates: [], attestation: null, ...overrides }
}

function file(name, claim, key = 'file:1') {
  return { absolute: `${REPO}/${name}`, path: name, claim, key, documentation: isDocumentationPath(name) }
}

function catalog(items = [], state = 'readable', problem = null) {
  return { path: `${REPO}/.dsh/verification.json`, state, items, problem }
}

test('repositoryDigest changes when a content key changes or a file is added, and not when a claim changes', async () => {
  const root = makeRoot('digest-')
  fs.writeFileSync(path.join(root, 'app.js'), 'one\n')
  const tracker = new RepositoryTracker()
  await tracker.merge('s', { turn: 1, seq: 1, base: root, files: ['app.js'], fallback: root })
  await tracker.refresh('s')
  const repo = tracker.repo('s', root)
  const before = repositoryDigest(repo)

  repo.files.get(path.join(root, 'app.js')).claim = 'mine'
  assert.equal(repositoryDigest(repo), before, 'a claim is not part of the digest')

  fs.writeFileSync(path.join(root, 'app.js'), 'two\n')
  await tracker.refresh('s')
  const edited = repositoryDigest(repo)
  assert.notEqual(edited, before, 'a changed content key changes the digest')

  fs.writeFileSync(path.join(root, 'more.js'), 'new\n')
  await tracker.merge('s', { turn: 1, seq: 2, base: root, files: ['more.js'], fallback: root })
  await tracker.refresh('s')
  assert.notEqual(repositoryDigest(repo), edited, 'a file added to the record changes the digest')
})

test('evaluateRepository names each unmet obligation in the stated wording', () => {
  const result = evaluateRepository(snapshot({
    files: [file('app.js', 'unclaimed'), file('notes.md', 'mine', 'file:2')],
    itemStates: [],
  }), catalog([{ id: 'unit', name: 'Unit tests' }]))
  assert.deepEqual(result.problems, [
    `Unclaimed changed files: ${REPO}/app.js. Claim each as yours, or reject it.`,
    `Changed documentation not checked: ${REPO}/notes.md. Check each for staleness, bloat, and conflicting information, then attest with docs_checked true.`,
    'Catalog item not stated: unit (Unit tests).',
    'No current attestation for this repository.',
  ])
  assert.equal(result.complete, false)
})

test('evaluateRepository reports code claimed but not reviewed, and an unreadable catalog', () => {
  const result = evaluateRepository(snapshot({
    files: [file('app.js', 'mine')],
    attestation: { reviewed: [], docsChecked: false, summary: '', digest: 'd', createdAt: 1 },
  }), catalog([], 'unreadable', 'the file is not valid JSON: x'))
  assert.deepEqual(result.problems, [
    `Claimed code files not reviewed: ${REPO}/app.js.`,
    'The catalog cannot be read: the file is not valid JSON: x.',
  ])
})

test('evaluateRepository is complete only when every obligation is met, and a rejected file adds no problem', () => {
  const rejected = evaluateRepository(snapshot({
    files: [file('gone.js', 'not-mine'), file('NOTES.md', 'not-mine', 'file:3')],
    attestation: { reviewed: [], docsChecked: false, summary: '', digest: 'd', createdAt: 1 },
  }), catalog([]))
  assert.deepEqual(rejected.problems, [], 'a rejected code file and a rejected document give no problem')
  assert.equal(rejected.complete, true)

  const done = evaluateRepository(snapshot({
    files: [file('app.js', 'mine'), file('README.md', 'mine', 'file:4')],
    itemStates: [{ id: 'unit', state: 'passed' }],
    attestation: { reviewed: [`${REPO}/app.js`], docsChecked: true, summary: '', digest: 'd', createdAt: 1 },
  }), catalog([{ id: 'unit', name: 'Unit tests' }]))
  assert.deepEqual(done.problems, [])
  assert.equal(done.complete, true)
  assert.deepEqual(done.items, [{ id: 'unit', name: 'Unit tests', state: 'passed', reason: undefined }])
})

test('attestSchemaErrors refuses retired keys, bad decisions, and item states without a valid reason', () => {
  assert.deepEqual(attestSchemaErrors({ action: 'attest', repository_root: REPO, acceptance_criteria: [] }), ['Unknown argument: acceptance_criteria.'])
  assert.match(attestSchemaErrors({ repository_root: REPO, claims: [{ path: 'app.js', decision: 'maybe' }] }).join(' '), /decision/)
  assert.match(attestSchemaErrors({ repository_root: REPO, items: [{ id: 'unit', state: 'assumed' }] }).join(' '), /reason/)
  assert.match(attestSchemaErrors({ repository_root: REPO, items: [{ id: 'unit', state: 'passed', reason: 'ran it' }] }).join(' '), /reason/)
  assert.match(attestSchemaErrors({ action: 'attest' }).join(' '), /repository_root/)
  assert.match(attestSchemaErrors({ repository_root: REPO, items: [{ id: 'unit', state: 'passed', name: 'Unit' }] }).join(' '), /name/)
  assert.deepEqual(attestSchemaErrors({
    action: 'attest', repository_root: REPO, claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'],
    docs_checked: false, items: [{ id: 'unit', state: 'assumed', reason: 'the suite needs a database' }], summary: 'done',
  }), [], 'a well-formed call has no schema error')
})

test('planAttest refuses a path that is not a changed file, an unknown item, and an unreadable catalog', () => {
  const snap = snapshot({ files: [file('app.js', 'unclaimed')] })
  assert.throws(() => planAttest(snap, { claims: [{ path: 'nope.js', decision: 'mine' }] }, catalog()), error => {
    assert.ok(error instanceof AttestRefusal)
    assert.match(error.errors.join(' '), /nope\.js is not a changed file of this repository/)
    assert.match(error.message, /Nothing was changed\./)
    return true
  })
  assert.throws(() => planAttest(snap, { items: [{ id: 'ghost', state: 'passed' }] }, catalog([{ id: 'unit', name: 'Unit' }])), /ghost/)
  assert.throws(() => planAttest(snap, { items: [{ id: 'unit', state: 'passed' }] }, catalog([], 'unreadable', 'bad json')), /The catalog cannot be read: bad json/)

  const plan = planAttest(snap, { claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'] }, catalog())
  assert.deepEqual(plan.claims, [{ absolute: `${snap.root}/app.js`, decision: 'mine' }])
  assert.deepEqual(plan.reviewed, [`${snap.root}/app.js`])
})

test('a recorded file whose bytes change after attestation reopens the repository', async () => {
  const root = makeRoot('reopen-')
  fs.writeFileSync(path.join(root, 'app.js'), 'one\n')
  const tracker = new RepositoryTracker()
  await tracker.merge('s', { turn: 1, seq: 1, base: root, files: ['app.js'], fallback: root })
  await tracker.refresh('s')
  const plan = planAttest(tracker.repositories('s').find(r => r.root === root),
    { claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'], items: [{ id: 'unit', state: 'passed' }] },
    catalog([{ id: 'unit', name: 'Unit' }]))
  tracker.applyAttest('s', root, plan, 1)
  assert.deepEqual(tracker.reopenChanged('s'), [], 'an attestation over unchanged bytes keeps the repository')

  fs.writeFileSync(path.join(root, 'app.js'), 'two\n')
  await tracker.refresh('s')
  assert.deepEqual(tracker.reopenChanged('s'), [root])
  const after = tracker.repositories('s').find(r => r.root === root)
  assert.equal(after.files[0].claim, 'unclaimed', 'the claim is cleared')
  assert.deepEqual(after.itemStates, [], 'the item states are cleared')
  assert.equal(after.attestation, null, 'the attestation is dropped')
})
