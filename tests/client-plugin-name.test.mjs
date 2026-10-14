import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = new URL('../', import.meta.url)
// CG_CLIENT_FILE lets the same test be pointed at another copy of the browser
// half, which is how the exported-name assertion is shown to be load-bearing.
const clientFile = process.env.CG_CLIENT_FILE ?? new URL('lib/client.js', root)
const profilePackage = process.env.CG_PROFILE_PACKAGE ?? path.join(os.homedir(), '.dsh', 'profiles', 'web', 'package.json')

/** Materialize the browser half under a minimal window stub and return its registration. */
function loadClientHalf() {
  const source = fs.readFileSync(clientFile, 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: value => { registration = value } } }
  const require = specifier => {
    assert.equal(specifier, 'react', `browser half required an unexpected module: ${specifier}`)
    const noop = () => {}
    return { createElement: noop, useEffect: noop, useMemo: noop, useState: noop }
  }
  new Function('window', 'require', source)(window, require)
  assert.ok(registration, 'the browser half never called window.__ModuleLoader__.load')
  assert.equal(typeof registration.factory, 'function', 'the registration carries no factory')
  return { id: registration.id, exports: registration.factory(require) }
}

test('browser half exports the plugin name carried by the bundle key and the load id', t => {
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'))
  const half = loadClientHalf()

  // The profile bundle key is the authoritative name; when the profile is not
  // readable the in-repo package name and load id still pin the same string.
  if (fs.existsSync(profilePackage)) {
    const profile = JSON.parse(fs.readFileSync(profilePackage, 'utf8'))
    const bundles = profile.dsh?.profile?.bundles ?? []
    assert.ok(bundles.includes(pkg.name), `profile bundles do not declare the plugin name ${pkg.name}`)
    t.diagnostic(`bundle key ${pkg.name} mounted from ${profile.dependencies?.[pkg.name] ?? 'unknown spec'}`)
  } else {
    t.diagnostic(`profile package ${profilePackage} is not readable; bundle-key cross-check skipped`)
  }

  assert.equal(half.id, pkg.name, 'the __ModuleLoader__ load id differs from the package name')
  assert.equal(half.exports.name, pkg.name, 'the browser half exports no plugin name matching the bundle key')
})

test('cordis.patch.yml mounts the same plugin name', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'))
  const patch = fs.readFileSync(new URL('cordis.patch.yml', root), 'utf8')
  const row = patch.split('\n').map(line => line.trim()).find(line => line.startsWith('name:'))
  assert.equal(row, `name: ${pkg.name}`, 'the patch row name differs from the bundle key')
})
