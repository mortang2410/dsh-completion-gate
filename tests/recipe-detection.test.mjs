import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RECIPE_DEFAULT_OPTIONS, detectRecipe, isVerifyingRecipe, normalizeRecipe } from '../lib/recipe.js'

function make(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recipe-detect-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

test('node recipe uses npm without a lockfile and carries scripts, port and readiness', t => {
  const dir = make(t, {
    'package.json': { name: 'x', scripts: { dev: 'next dev', build: 'next build', test: 'node --test' }, dependencies: { next: '1' } },
  })
  assert.deepEqual(detectRecipe(dir), {
    name: 'Next.js', kind: 'nextjs', bootstrap: ['npm install'], build: ['npm run build'], test: ['npm run test'],
    start: 'npm run dev', port: 3000, readinessPath: '/',
    evidence: ['Detected package.json', 'Package manager: npm', 'Scripts: dev, build, test'],
  })
})

test('node package manager comes from the lockfile', t => {
  const cases = [
    ['pnpm-lock.yaml', 'pnpm install', 'pnpm run test'],
    ['yarn.lock', 'yarn install', 'yarn test'],
    ['bun.lockb', 'bun install', 'bun run test'],
    ['bun.lock', 'bun install', 'bun run test'],
    ['package-lock.json', 'npm install', 'npm run test'],
  ]
  for (const [lock, install, test_] of cases) {
    const dir = make(t, { 'package.json': { name: 'x', scripts: { test: 'node --test' } }, [lock]: '' })
    const recipe = detectRecipe(dir)
    assert.equal(recipe.bootstrap[0], install, lock)
    assert.deepEqual(recipe.test, [test_], lock)
    assert.equal(recipe.start, null, lock)
    assert.equal(recipe.port, null, lock)
  }
})

test('node framework supplies its conventional port', t => {
  const cases = [
    ['next', 'nextjs', 'Next.js', 3000],
    ['@sveltejs/kit', 'sveltekit', 'SvelteKit', 5173],
    ['astro', 'astro', 'Astro', 4321],
    ['@remix-run/dev', 'remix', 'Remix', 3000],
    ['react-scripts', 'cra', 'Create React App', 3000],
    ['vite', 'vite', 'Vite', 5173],
  ]
  for (const [module, kind, name, port] of cases) {
    const dir = make(t, { 'package.json': { name: 'x', scripts: { dev: 'serve' }, dependencies: { [module]: '1' } } })
    const recipe = detectRecipe(dir)
    assert.equal(recipe.kind, kind, module)
    assert.equal(recipe.name, name, module)
    assert.equal(recipe.port, port, module)
  }
})

test('a port named in the start script wins over the framework default', t => {
  const dir = make(t, { 'package.json': { name: 'x', scripts: { dev: 'vite --port 4321' }, dependencies: { vite: '1' } } })
  assert.equal(detectRecipe(dir).port, 4321)
  const env = make(t, { 'package.json': { name: 'x', scripts: { start: 'PORT=7777 node server.js' } } })
  assert.equal(detectRecipe(env).port, 7777)
})

test('python detection covers django, fastapi, flask and generic projects', t => {
  const django = make(t, { 'manage.py': '', 'requirements.txt': 'Django\n' })
  assert.deepEqual(detectRecipe(django), {
    name: 'Django app', kind: 'django', bootstrap: ['pip install -r requirements.txt'], build: [], test: ['python manage.py test'],
    start: 'python manage.py runserver 0.0.0.0:8000', port: 8000, readinessPath: '/',
    evidence: ['Detected manage.py', 'Detected Python project'],
  })
  const fastapi = make(t, { 'requirements.txt': 'fastapi\nuvicorn\n', 'main.py': '' })
  assert.equal(detectRecipe(fastapi).kind, 'fastapi')
  assert.equal(detectRecipe(fastapi).start, 'uvicorn main:app --host 0.0.0.0 --port 8000')
  assert.equal(detectRecipe(fastapi).port, 8000)
  const flask = make(t, { 'requirements.txt': 'flask\n', 'app.py': '' })
  assert.equal(detectRecipe(flask).kind, 'flask')
  assert.equal(detectRecipe(flask).start, 'flask --app app.py run --host 0.0.0.0 --port 5000')
  assert.equal(detectRecipe(flask).port, 5000)
  const generic = make(t, { 'requirements.txt': 'requests\n' })
  assert.deepEqual(detectRecipe(generic), {
    name: 'Python project', kind: 'python', bootstrap: ['pip install -r requirements.txt'], build: [], test: ['python -m unittest discover'],
    start: null, port: null, readinessPath: '/', evidence: ['Detected Python project'],
  })
})

test('go, rust, maven and gradle recipes come from their build manifests', t => {
  const go = detectRecipe(make(t, { 'go.mod': 'module x\n', 'main.go': '' }))
  assert.deepEqual(go, { name: 'Go project', kind: 'go', bootstrap: [], build: ['go build ./...'], test: ['go test ./...'], start: 'go run .', port: null, readinessPath: '/', evidence: ['Detected go.mod'] })
  assert.equal(detectRecipe(make(t, { 'go.mod': 'module x\n' })).start, null)
  const rust = detectRecipe(make(t, { 'Cargo.toml': '[package]\n', 'src/main.rs': '' }))
  assert.equal(rust.kind, 'rust')
  assert.deepEqual(rust.build, ['cargo build'])
  assert.deepEqual(rust.test, ['cargo test'])
  assert.equal(rust.start, 'cargo run')
  const maven = detectRecipe(make(t, { 'pom.xml': '<project/>' }))
  assert.deepEqual([maven.kind, maven.build, maven.test], ['maven', ['mvn package'], ['mvn test']])
  const gradle = detectRecipe(make(t, { 'build.gradle': '', 'gradlew': '' }))
  assert.deepEqual([gradle.kind, gradle.build, gradle.test], ['gradle', ['./gradlew build'], ['./gradlew test']])
})

test('a Makefile contributes only the targets it defines', t => {
  const dir = make(t, { Makefile: 'install:\n\tnpm ci\nbuild:\n\ttsc\ntest:\n\tnode --test\nrun:\n\tnode .\n' })
  const recipe = detectRecipe(dir)
  assert.deepEqual(recipe.bootstrap, ['make install'])
  assert.deepEqual(recipe.build, ['make build'])
  assert.deepEqual(recipe.test, ['make test'])
  assert.equal(recipe.start, 'make run')
  const partial = detectRecipe(make(t, { Makefile: 'build:\n\ttsc\n' }))
  assert.deepEqual([partial.bootstrap, partial.test, partial.start], [[], [], null])
})

test('a compose file yields a compose build and start', t => {
  const recipe = detectRecipe(make(t, { 'compose.yaml': 'services:\n  web:\n    image: nginx\n' }))
  assert.deepEqual([recipe.kind, recipe.build, recipe.start], ['compose', ['docker compose build'], 'docker compose up'])
  assert.deepEqual(recipe.evidence, ['Detected compose.yaml'])
})

test('node wins over other markers and detection can be turned off', t => {
  const dir = make(t, { 'package.json': { name: 'x' }, 'go.mod': 'module x\n' })
  assert.equal(detectRecipe(dir).kind, 'node')
  assert.equal(detectRecipe(dir, { autoDetectRecipe: false }), null)
  assert.equal(detectRecipe(make(t, {})), null)
})

test('only a build, a test or a start counts as verification', t => {
  assert.equal(isVerifyingRecipe({ name: 'x', bootstrap: ['npm install'] }), false)
  assert.equal(isVerifyingRecipe({ name: 'x', build: ['npm run build'] }), true)
  assert.equal(isVerifyingRecipe({ name: 'x', test: ['npm run test'] }), true)
  assert.equal(isVerifyingRecipe({ name: 'x', start: 'npm start' }), true)
  assert.equal(isVerifyingRecipe(null), false)
  const bootstrapOnly = detectRecipe(make(t, { 'package.json': { name: 'x' } }))
  assert.deepEqual(bootstrapOnly.bootstrap, ['npm install'])
  assert.equal(isVerifyingRecipe(bootstrapOnly), false)
})

test('normalizeRecipe rejects nameless input and repairs loose field shapes', () => {
  assert.equal(normalizeRecipe(null), null)
  assert.equal(normalizeRecipe({ kind: 'node' }), null)
  assert.deepEqual(normalizeRecipe({ name: '  x  ', kind: '', port: '3000', readinessPath: 'health', test: 'node --test' }), {
    name: 'x', kind: 'unknown', bootstrap: [], build: [], test: ['node --test'], start: null, port: 3000, readinessPath: '/', evidence: [],
  })
  assert.equal(normalizeRecipe({ name: 'x', port: 99999 }).port, null)
})

test('the exported option names are the ones detection honors', t => {
  assert.deepEqual(Object.keys(RECIPE_DEFAULT_OPTIONS), ['autoDetectRecipe', 'recipeReadinessTimeoutMs'])
  const dir = make(t, { 'package.json': { name: 'x' } })
  assert.equal(detectRecipe(dir, { autoDetectRecipe: RECIPE_DEFAULT_OPTIONS.autoDetectRecipe }).kind, 'node')
})
