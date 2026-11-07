import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const root = new URL('../', import.meta.url)

test('source release is dependency-free and complete', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'))
  assert.equal(pkg.version, '0.2.0')
  assert.deepEqual(pkg.dependencies ?? {}, {})
  for (const file of ['lib/index.js', 'lib/core.js', 'lib/settings.js', 'lib/client.js', 'lib/changes.js', 'lib/report.js', 'lib/repositories.js', 'lib/tracker.js', 'lib/catalog.js', 'cordis.patch.yml']) {
    assert.equal(fs.existsSync(new URL(file, root)), true, `missing released file: ${file}`)
  }
  assert.equal(pkg.files.includes('src'), false, 'the removed duplicate tree is still published')
  assert.equal(fs.existsSync(new URL('src', root)), false, 'the removed duplicate tree still exists')
})

test('every package entry point resolves inside the loaded tree', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'))
  const targets = [['main', pkg.main], ...Object.entries(pkg.exports).filter(([subpath]) => subpath !== './package.json')]
  for (const [label, target] of targets) {
    assert.match(target, /^(?:\.\/)?lib\//, `${label} resolves outside the loaded tree: ${target}`)
    assert.equal(fs.existsSync(new URL(target, root)), true, `${label} points at a missing file: ${target}`)
  }
})

test('control center exposes persistent editable settings', () => {
  const text = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const marker of ['Save settings', 'Reset to profile defaults', 'Premature-stop guard', 'Gate subagents', 'Security regression scan', 'Maximum changed files', 'Verification nudge limit']) {
    assert.equal(text.includes(marker), true, `missing UI marker: ${marker}`)
  }
  assert.equal(text.includes("api('/settings'"), true)
  assert.equal(text.includes("api('/settings/reset'"), true)
})

test('the check script syntax-checks every surviving lib file', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'))
  const libFiles = fs.readdirSync(new URL('lib/', root)).filter(name => name.endsWith('.js'))
  for (const file of libFiles) {
    assert.ok(pkg.scripts.check.includes(`lib/${file}`), `npm run check does not syntax-check lib/${file}`)
  }
})

test('README is complete enough for a new operator', () => {
  const text = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  for (const heading of ['Why this plugin exists', 'Core behavior', 'Control Center', 'Commands', 'Installation', 'Interaction with model failover / Phoenix', 'Important limits', 'Privacy and security']) {
    assert.equal(text.includes(`## ${heading}`), true, `missing README section: ${heading}`)
  }
  assert.match(text, /completion_gate/)
  assert.match(text, /Reset to profile defaults/)
  assert.doesNotMatch(text, /packaged \.tgz|npm package|install the packaged/i)
})
