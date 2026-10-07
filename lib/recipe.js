import fs from 'node:fs'
import path from 'node:path'
import { RECIPE_DEFAULT_OPTIONS, cleanText, readJson } from './core.js'

// A recipe is a plain object:
//   { name, kind, bootstrap[], build[], test[], start|null, port|null, readinessPath, evidence[] }
// Commands are shell strings run in the project root, in list order. `port` is the port the
// start command is expected to listen on and readinessPath the path polled after it boots.
// Detection order and command choices mirror the Hermes verify subsystem
// (agent/verify/recipes.py): package.json, then Python, Go/Rust, Maven/Gradle, Makefile, Compose.

export const RECIPE_MANIFEST_VERSION = 1
export const RECIPE_MANIFEST_RELPATH = path.join('.dsh', 'environment.json')
export const RECIPE_PHASES = Object.freeze(['bootstrap', 'build', 'test', 'start'])

// Re-exported from lib/core.js, which owns the plugin config defaults, so recipe detection and
// the plugin configuration cannot disagree about an option name or its default.
export { RECIPE_DEFAULT_OPTIONS }

export function manifestPath(cwd) { return path.join(path.resolve(cwd), RECIPE_MANIFEST_RELPATH) }

function commandList(value) {
  const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  return [...new Set(values.filter(v => typeof v === 'string' && v.trim()).map(v => cleanText(v, 2000).trim()))]
}

export function normalizeRecipe(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const name = cleanText(raw.name ?? '', 200).trim()
  if (!name) return null
  const rawPort = typeof raw.port === 'string' ? Number(raw.port.trim()) : raw.port
  return {
    name,
    kind: cleanText(raw.kind ?? '', 60).trim() || 'unknown',
    bootstrap: commandList(raw.bootstrap), build: commandList(raw.build), test: commandList(raw.test),
    start: typeof raw.start === 'string' && raw.start.trim() ? cleanText(raw.start, 2000).trim() : null,
    port: Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : null,
    readinessPath: typeof raw.readinessPath === 'string' && raw.readinessPath.startsWith('/') ? cleanText(raw.readinessPath, 500) : '/',
    evidence: commandList(raw.evidence),
  }
}

// Verification requires a build, a test, or a start (readiness url is derived from the port).
// Bootstrap alone installs dependencies and proves nothing about the application.
export function isVerifyingRecipe(recipe) {
  const clean = normalizeRecipe(recipe)
  return Boolean(clean && (clean.build.length || clean.test.length || clean.start))
}

const NODE_MANAGERS = [
  { lock: 'pnpm-lock.yaml', manager: 'pnpm', install: 'pnpm install', run: script => `pnpm run ${script}` },
  { lock: 'yarn.lock', manager: 'yarn', install: 'yarn install', run: script => `yarn ${script}` },
  { lock: 'bun.lockb', manager: 'bun', install: 'bun install', run: script => `bun run ${script}` },
  { lock: 'bun.lock', manager: 'bun', install: 'bun install', run: script => `bun run ${script}` },
]
const NPM_MANAGER = { manager: 'npm', install: 'npm install', run: script => `npm run ${script}` }
const NODE_FRAMEWORKS = [
  { modules: ['next'], kind: 'nextjs', name: 'Next.js', port: 3000 },
  { modules: ['@sveltejs/kit'], kind: 'sveltekit', name: 'SvelteKit', port: 5173 },
  { modules: ['astro'], kind: 'astro', name: 'Astro', port: 4321 },
  { modules: ['@remix-run/dev', '@remix-run/react'], kind: 'remix', name: 'Remix', port: 3000 },
  { modules: ['react-scripts'], kind: 'cra', name: 'Create React App', port: 3000 },
  { modules: ['vite'], kind: 'vite', name: 'Vite', port: 5173 },
]

function nodeManager(cwd) { return NODE_MANAGERS.find(m => fs.existsSync(path.join(cwd, m.lock))) || NPM_MANAGER }

function inferPort(command) {
  const match = /(?:--port|-p)\s+(\d{2,5})/.exec(command || '') || /\bPORT=(\d{2,5})\b/.exec(command || '')
  return match ? Number(match[1]) : null
}

function detectNodeRecipe(cwd) {
  const pkg = readJson(path.join(cwd, 'package.json'))
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return null
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : {}
  // `npm init -y` writes a test script that only fails; treat it as absent, as detectChecks does.
  const has = name => typeof scripts[name] === 'string' && scripts[name].trim() && !/no test specified/i.test(scripts[name])
  const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
  const framework = NODE_FRAMEWORKS.find(f => f.modules.some(module => Object.hasOwn(dependencies, module)))
  const manager = nodeManager(cwd)
  const scriptsFrom = names => names.filter(has).map(name => manager.run(name))
  const startScript = ['dev', 'start'].find(has) || null
  return normalizeRecipe({
    name: framework?.name || 'Node.js app', kind: framework?.kind || 'node', bootstrap: [manager.install],
    build: scriptsFrom(['build', 'typecheck']), test: scriptsFrom(['test', 'check', 'lint']),
    start: startScript ? manager.run(startScript) : null,
    port: startScript ? inferPort(scripts[startScript]) ?? framework?.port ?? null : null,
    readinessPath: '/',
    evidence: ['Detected package.json', `Package manager: ${manager.manager}`, `Scripts: ${Object.keys(scripts).join(', ') || '(none)'}`],
  })
}

function readText(cwd, name) { try { return fs.readFileSync(path.join(cwd, name), 'utf8') } catch { return null } }
function exists(cwd, name) { return fs.existsSync(path.join(cwd, name)) }

function detectPythonRecipe(cwd) {
  const pyproject = readText(cwd, 'pyproject.toml'), requirements = readText(cwd, 'requirements.txt')
  const manage = exists(cwd, 'manage.py')
  if (pyproject === null && requirements === null && !manage && !exists(cwd, 'setup.py')) return null
  const lower = `${pyproject || ''}\n${requirements || ''}`.toLowerCase()
  const shared = {
    bootstrap: [requirements === null ? 'pip install -e .' : 'pip install -r requirements.txt'],
    readinessPath: '/', evidence: ['Detected Python project'],
  }
  const pytest = exists(cwd, 'tests') ? ['python -m pytest'] : []
  if (manage || lower.includes('django')) return normalizeRecipe({
    ...shared, name: 'Django app', kind: 'django', test: ['python manage.py test'],
    start: 'python manage.py runserver 0.0.0.0:8000', port: 8000,
    evidence: [manage ? 'Detected manage.py' : 'Detected Django dependency', 'Detected Python project'],
  })
  if (lower.includes('fastapi') || lower.includes('uvicorn')) {
    const module = exists(cwd, 'main.py') ? 'main' : exists(cwd, 'app.py') ? 'app' : 'main'
    return normalizeRecipe({
      ...shared, name: 'FastAPI app', kind: 'fastapi', test: pytest,
      start: `uvicorn ${module}:app --host 0.0.0.0 --port 8000`, port: 8000,
      evidence: ['Detected Python project', 'Detected FastAPI/Uvicorn dependency'],
    })
  }
  if (lower.includes('flask')) return normalizeRecipe({
    ...shared, name: 'Flask app', kind: 'flask', test: pytest,
    start: `flask --app ${exists(cwd, 'app.py') ? 'app.py' : 'main.py'} run --host 0.0.0.0 --port 5000`, port: 5000,
    evidence: ['Detected Python project', 'Detected Flask dependency'],
  })
  return normalizeRecipe({ ...shared, name: 'Python project', kind: 'python', test: pytest.length ? pytest : ['python -m unittest discover'] })
}

const SIMPLE_TOOLCHAINS = [
  { manifest: 'go.mod', name: 'Go project', kind: 'go', build: ['go build ./...'], test: ['go test ./...'], start: 'go run .', entry: 'main.go' },
  { manifest: 'Cargo.toml', name: 'Rust project', kind: 'rust', build: ['cargo build'], test: ['cargo test'], start: 'cargo run', entry: path.join('src', 'main.rs') },
]

function detectSimpleRecipe(cwd) {
  const toolchain = SIMPLE_TOOLCHAINS.find(t => exists(cwd, t.manifest))
  return toolchain ? normalizeRecipe({
    name: toolchain.name, kind: toolchain.kind, build: toolchain.build, test: toolchain.test,
    start: exists(cwd, toolchain.entry) ? toolchain.start : null, readinessPath: '/',
    evidence: [`Detected ${toolchain.manifest}`],
  }) : null
}

function detectJavaRecipe(cwd) {
  if (exists(cwd, 'pom.xml')) return normalizeRecipe({ name: 'Maven project', kind: 'maven', build: ['mvn package'], test: ['mvn test'], evidence: ['Detected pom.xml'] })
  if (exists(cwd, 'build.gradle') || exists(cwd, 'build.gradle.kts')) {
    const gradle = exists(cwd, 'gradlew') ? './gradlew' : 'gradle'
    return normalizeRecipe({ name: 'Gradle project', kind: 'gradle', build: [`${gradle} build`], test: [`${gradle} test`], evidence: ['Detected Gradle build file'] })
  }
  return null
}

const MAKE_TARGET_RE = /^([A-Za-z0-9_.-]+):(?:\s|$)/
const MAKE_PHASE_TARGETS = {
  bootstrap: ['install', 'setup', 'bootstrap'], build: ['build', 'compile'], test: ['test', 'check'], start: ['run', 'start', 'serve', 'dev'],
}

function detectMakeRecipe(cwd) {
  const makefile = readText(cwd, 'Makefile')
  if (makefile === null) return null
  const targets = makefile.split('\n').map(line => MAKE_TARGET_RE.exec(line)).filter(Boolean).map(match => match[1])
  const pick = names => names.filter(name => targets.includes(name)).slice(0, 1).map(name => `make ${name}`)
  return normalizeRecipe({
    name: 'Makefile-driven project', kind: 'make', bootstrap: pick(MAKE_PHASE_TARGETS.bootstrap), build: pick(MAKE_PHASE_TARGETS.build),
    test: pick(MAKE_PHASE_TARGETS.test), start: pick(MAKE_PHASE_TARGETS.start)[0] || null,
    readinessPath: '/', evidence: ['Detected Makefile', `Targets: ${targets.join(', ') || '(none)'}`],
  })
}

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']

function detectComposeRecipe(cwd) {
  const file = COMPOSE_FILES.find(name => exists(cwd, name))
  return file ? normalizeRecipe({
    name: 'docker-compose project', kind: 'compose', build: ['docker compose build'], start: 'docker compose up',
    readinessPath: '/', evidence: [`Detected ${file}`],
  }) : null
}

export function detectRecipe(cwd, options = {}) {
  if (options.autoDetectRecipe === false) return null
  const dir = path.resolve(cwd)
  return detectNodeRecipe(dir) || detectPythonRecipe(dir) || detectSimpleRecipe(dir) || detectJavaRecipe(dir) || detectMakeRecipe(dir) || detectComposeRecipe(dir)
}

// Saved manifest (operator intent, versioned wrapper). Any read, parse or shape problem
// falls back to detection and reports the problem; the recipe itself is returned as written
// and is never merged with or rewritten by detected values.
export function loadManifest(cwd) {
  const file = manifestPath(cwd)
  let text
  try { text = fs.readFileSync(file, 'utf8') }
  catch (error) {
    return error?.code === 'ENOENT'
      ? { recipe: null, problem: null }
      : { recipe: null, problem: `Saved recipe ${RECIPE_MANIFEST_RELPATH} could not be read: ${cleanText(error?.message || error, 200)}. Falling back to detection.` }
  }
  let parsed
  try { parsed = JSON.parse(text) }
  catch (error) { return { recipe: null, problem: `Saved recipe ${RECIPE_MANIFEST_RELPATH} is not valid JSON: ${cleanText(error?.message || error, 200)}. Falling back to detection.` } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { recipe: null, problem: `Saved recipe ${RECIPE_MANIFEST_RELPATH} is not a recipe wrapper object. Falling back to detection.` }
  if (parsed.version !== RECIPE_MANIFEST_VERSION) {
    return { recipe: null, problem: `Saved recipe ${RECIPE_MANIFEST_RELPATH} has unsupported version ${cleanText(JSON.stringify(parsed.version ?? null), 40)}; expected ${RECIPE_MANIFEST_VERSION}. Falling back to detection.` }
  }
  const recipe = normalizeRecipe(parsed.recipe)
  return recipe
    ? { recipe, problem: null }
    : { recipe: null, problem: `Saved recipe ${RECIPE_MANIFEST_RELPATH} does not describe a usable recipe (a name is required). Falling back to detection.` }
}

export function saveManifest(cwd, recipe) {
  const clean = normalizeRecipe(recipe)
  if (!clean) throw new Error('saveManifest requires a recipe with a name.')
  const file = manifestPath(cwd)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify({ version: RECIPE_MANIFEST_VERSION, recipe: clean, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  return file
}

export function resolveRecipe(cwd, options = {}) {
  const saved = loadManifest(cwd)
  if (saved.recipe) return { recipe: saved.recipe, source: 'manifest', problems: [] }
  const detected = detectRecipe(cwd, options)
  return { recipe: detected, source: detected ? 'detected' : 'none', problems: saved.problem ? [saved.problem] : [] }
}
