import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('source release is dependency-free and complete', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.version, '0.1.3')
  assert.deepEqual(pkg.dependencies ?? {}, {})
  for (const file of ['src/index.js', 'src/core.js', 'src/runner.js', 'src/settings.js', 'src/client.js', 'lib/settings.js', 'cordis.patch.yml']) {
    assert.equal(fs.existsSync(new URL(`../${file}`, import.meta.url)), true)
  }
})

test('control center exposes persistent editable settings', () => {
  const text = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  for (const marker of ['Save settings', 'Reset to profile defaults', 'Require tests', 'Premature-stop guard', 'Custom checks', 'Gate subagents']) {
    assert.equal(text.includes(marker), true, `missing UI marker: ${marker}`)
  }
  assert.equal(text.includes("api('/settings'"), true)
  assert.equal(text.includes("api('/settings/reset'"), true)
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
