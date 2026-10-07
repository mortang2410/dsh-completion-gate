import fs from 'node:fs'
import path from 'node:path'

// Recipe option defaults live here so the plugin config has one source of truth;
// lib/recipe.js imports and re-exports them for its documented API.
export const RECIPE_DEFAULT_OPTIONS = Object.freeze({
  autoDetectRecipe: true,
  recipeReadinessTimeoutMs: 60_000,
})

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  mode: 'strict',
  gateSubagents: false,
  preventPrematureStops: true,
  prematureStopMaxContinuations: 3,
  autoDetectChecks: true,
  requireTests: true,
  requireBuildWhenAvailable: true,
  requireLintWhenAvailable: true,
  requireTypecheckWhenAvailable: true,
  blockNewTodos: true,
  securityScan: true,
  requireAttestation: true,
  gateOnlyChangedWorkspaces: true,
  commandTimeoutMs: 600_000,
  maxOutputChars: 12_000,
  maxChangedFiles: 500,
  // Recipe detection and the targeted ad-hoc fallback.
  autoDetectRecipe: RECIPE_DEFAULT_OPTIONS.autoDetectRecipe,
  allowTemporaryVerifier: true,
  recipeReadinessTimeoutMs: RECIPE_DEFAULT_OPTIONS.recipeReadinessTimeoutMs,
  verificationNudgeLimit: 3,
  customChecks: [],
})

export function resolveConfig(config = {}) {
  const bool = key => typeof config[key] === 'boolean' ? config[key] : DEFAULT_CONFIG[key]
  const int = (key, min, max) => Number.isFinite(config[key]) ? Math.min(max, Math.max(min, Math.floor(config[key]))) : DEFAULT_CONFIG[key]
  const mode = ['strict','advisory'].includes(config.mode) ? config.mode : DEFAULT_CONFIG.mode
  const customChecks = Array.isArray(config.customChecks) ? config.customChecks
    .filter(v => v && typeof v === 'object' && typeof v.name === 'string' && typeof v.command === 'string')
    .map(v => ({ name: cleanText(v.name,80), command:String(v.command), category:cleanText(v.category || 'custom',40), required:v.required !== false })) : []
  return {
    enabled:bool('enabled'), mode, gateSubagents:bool('gateSubagents'),
    preventPrematureStops:bool('preventPrematureStops'), prematureStopMaxContinuations:int('prematureStopMaxContinuations',0,20),
    autoDetectChecks:bool('autoDetectChecks'), requireTests:bool('requireTests'), requireBuildWhenAvailable:bool('requireBuildWhenAvailable'),
    requireLintWhenAvailable:bool('requireLintWhenAvailable'), requireTypecheckWhenAvailable:bool('requireTypecheckWhenAvailable'),
    blockNewTodos:bool('blockNewTodos'), securityScan:bool('securityScan'), requireAttestation:bool('requireAttestation'),
    gateOnlyChangedWorkspaces:bool('gateOnlyChangedWorkspaces'), commandTimeoutMs:int('commandTimeoutMs',1000,3_600_000),
    maxOutputChars:int('maxOutputChars',1000,100_000), maxChangedFiles:int('maxChangedFiles',10,5000), customChecks,
    autoDetectRecipe:bool('autoDetectRecipe'), allowTemporaryVerifier:bool('allowTemporaryVerifier'),
    recipeReadinessTimeoutMs:int('recipeReadinessTimeoutMs',1000,3_600_000), verificationNudgeLimit:int('verificationNudgeLimit',0,20),
  }
}

export function cleanText(value,max=4000){let text='';try{text=String(value??'')}catch{return ''}return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,'').slice(0,max)}
export function redactText(value,cwd='',max=12000){let text=cleanText(value,Math.max(max*2,max));if(cwd)text=text.split(cwd).join('[workspace]');text=text.replace(/(?<![A-Za-z0-9])(?:file:\/\/\/)?[A-Za-z]:[\\/][^\s<>"']+/g,'[local path]').replace(/(?<!:)\/(?:Users|home|mnt|tmp|var|opt|private|workspace)\/[^\s<>"']+/g,'[local path]').replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [redacted]').replace(/\b(api[_-]?key|access[_-]?token|authorization|password|passwd|secret)\s*[:=]\s*[^\s,;]+/gi,'$1=[redacted]');return text.length>max?`…${text.slice(-max)}`:text}
export function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}}
function pm(cwd,script){if(fs.existsSync(path.join(cwd,'pnpm-lock.yaml')))return `pnpm run ${script}`;if(fs.existsSync(path.join(cwd,'yarn.lock')))return `yarn ${script}`;if(fs.existsSync(path.join(cwd,'bun.lockb'))||fs.existsSync(path.join(cwd,'bun.lock')))return `bun run ${script}`;return `npm run ${script}`}
function nodeChecks(cwd,c){const pkg=readJson(path.join(cwd,'package.json'));if(!pkg?.scripts)return[];const out=[];const add=(category,names,required)=>{const name=names.find(n=>typeof pkg.scripts[n]==='string'&&pkg.scripts[n].trim());if(!name)return;if(category==='test'&&/no test specified/i.test(pkg.scripts[name]))return;out.push({id:`node:${name}`,category,name:`Node ${category}: ${name}`,command:pm(cwd,name),required})};add('test',['test','test:ci','test:unit'],c.requireTests);add('build',['build'],c.requireBuildWhenAvailable);add('lint',['lint','lint:check'],c.requireLintWhenAvailable);add('typecheck',['typecheck','type-check','check:types','types'],c.requireTypecheckWhenAvailable);return out}
function pythonChecks(cwd,c){const pp=path.join(cwd,'pyproject.toml');const has=fs.existsSync(pp)||fs.existsSync(path.join(cwd,'pytest.ini'))||fs.existsSync(path.join(cwd,'setup.cfg'));if(!has)return[];let t='';try{t=fs.readFileSync(pp,'utf8')}catch{}const out=[];if(c.requireTests&&(fs.existsSync(path.join(cwd,'tests'))||/\[tool\.pytest/i.test(t)))out.push({id:'py:test',category:'test',name:'Python tests',command:'python -m pytest',required:true});if(c.requireLintWhenAvailable&&/\[tool\.ruff/i.test(t))out.push({id:'py:ruff',category:'lint',name:'Python lint',command:'python -m ruff check .',required:true});if(c.requireTypecheckWhenAvailable&&/\[tool\.mypy/i.test(t))out.push({id:'py:mypy',category:'typecheck',name:'Python typecheck',command:'python -m mypy .',required:true});return out}
function nativeChecks(cwd,c){const out=[];if(fs.existsSync(path.join(cwd,'go.mod'))){if(c.requireTests)out.push({id:'go:test',category:'test',name:'Go tests',command:'go test ./...',required:true});if(c.requireLintWhenAvailable)out.push({id:'go:vet',category:'lint',name:'Go vet',command:'go vet ./...',required:true})}if(fs.existsSync(path.join(cwd,'Cargo.toml'))){if(c.requireTests)out.push({id:'rust:test',category:'test',name:'Rust tests',command:'cargo test --all-targets',required:true});if(c.requireBuildWhenAvailable)out.push({id:'rust:check',category:'build',name:'Rust check',command:'cargo check --all-targets',required:true})}const composer=readJson(path.join(cwd,'composer.json'));if(composer?.scripts){if(c.requireTests&&composer.scripts.test)out.push({id:'php:test',category:'test',name:'PHP tests',command:'composer test',required:true});if(c.requireLintWhenAvailable&&composer.scripts.lint)out.push({id:'php:lint',category:'lint',name:'PHP lint',command:'composer lint',required:true})}return out}
export function detectChecks(cwd,c){const checks=c.autoDetectChecks?[...nodeChecks(cwd,c),...pythonChecks(cwd,c),...nativeChecks(cwd,c)]:[];for(const x of c.customChecks)checks.push({id:`custom:${x.name}`,...x});const seen=new Set();return checks.filter(x=>!seen.has(x.id)&&seen.add(x.id))}
export function addedLinesFromDiff(diff){return String(diff||'').split(/\r?\n/).filter(l=>l.startsWith('+')&&!l.startsWith('+++')).map(l=>l.slice(1))}
export function scanTodos(lines){const hits=[];lines.forEach((line,i)=>{if(/\b(?:TODO|FIXME|HACK|XXX)\b/i.test(line))hits.push({line:i+1,text:cleanText(line.trim(),300)})});return hits.slice(0,100)}
const SECURITY_RULES=[['hardcoded-secret',/(?:api[_-]?key|password|passwd|secret|access[_-]?token)\s*[:=]\s*["'][^"']{8,}["']/i,'Possible hard-coded credential or secret'],['tls-js',/rejectUnauthorized\s*:\s*false/i,'TLS certificate verification disabled'],['tls-py',/verify\s*=\s*False\b/i,'TLS certificate verification disabled'],['eval',/\beval\s*\(/,'Dynamic eval introduced'],['new-function',/new\s+Function\s*\(/,'Dynamic Function constructor introduced'],['chmod',/chmod\s+(?:-R\s+)?777\b/,'World-writable permissions introduced'],['shell',/shell\s*:\s*true/,'Shell execution enabled; review command construction'],['html',/dangerouslySetInnerHTML\s*=/,'Raw HTML injection surface introduced']]
export function scanSecurity(lines){const hits=[];lines.forEach((line,i)=>{for(const[id,re,message]of SECURITY_RULES)if(re.test(line))hits.push({id,line:i+1,message,text:cleanText(line.trim(),300)})});return hits.slice(0,100)}
export function normalizeAttestation(args,fingerprint){return{fingerprint,reviewedFiles:Array.isArray(args.reviewed_files)?[...new Set(args.reviewed_files.map(v=>cleanText(v,500)).filter(Boolean))]:[],criteria:Array.isArray(args.acceptance_criteria)?args.acceptance_criteria.map(v=>typeof v==='string'?{criterion:cleanText(v,500),evidence:''}:{criterion:cleanText(v?.criterion,500),evidence:cleanText(v?.evidence,1500)}).filter(v=>v.criterion):[],unresolved:Array.isArray(args.unresolved_issues)?args.unresolved_issues.map(v=>cleanText(v,1000)).filter(Boolean):[],reviewSummary:cleanText(args.review_summary,4000),createdAt:Date.now()}}
export function evaluateAttestation(a,changed,fingerprint){const problems=[];if(!a||a.fingerprint!==fingerprint)return{pass:false,problems:['No completion attestation exists for the current workspace state.']};const reviewed=new Set(a.reviewedFiles);const missing=changed.filter(f=>!reviewed.has(f));if(missing.length)problems.push(`Changed files not reviewed: ${missing.slice(0,20).join(', ')}`);if(!a.reviewSummary.trim())problems.push('Changed-file review summary is missing.');if(!a.criteria.length)problems.push('Acceptance-criteria evidence is missing.');for(const c of a.criteria)if(!c.evidence.trim())problems.push(`Acceptance criterion has no evidence: ${c.criterion}`);if(a.unresolved.length)problems.push(`Unresolved issues remain: ${a.unresolved.join('; ')}`);return{pass:!problems.length,problems}}
export function reportMarkdown(r){const scope=r.documentationOnly?' · documentation-only turn':r.changesDetermined===false?' · changes undetermined':'';const lines=['# Completion Gate','',`${r.pass?'✅ **PASS**':'❌ **BLOCKED**'} · ${r.workspaceLabel}${scope}`,'',`Turn: \`${r.turn ?? 'unknown'}\` · change record: \`${String(r.recordSeq ?? 'none')}\``,'','## Machine evidence','','| Check | Category | Result | Duration |','|---|---|---:|---:|'];for(const c of r.checks||[])lines.push(`| ${c.name.replaceAll('|','\\|')} | ${c.category} | ${c.pass?'PASS':c.required?'FAIL':'WARN'} | ${c.durationMs==null?'—':`${c.durationMs} ms`} |`);if(!(r.checks||[]).length)lines.push(r.documentationOnly?'| Documentation-only turn: behavioral verification skipped | — | INFO | — |':'| No executable checks detected | — | INFO | — |');if(r.changedFiles?.length){lines.push('','## Files this turn changed','');for(const f of r.changedFiles.slice(0,50))lines.push(`- ${f}`)}if(r.blockers?.length){lines.push('','## Blocking reasons','');for(const b of r.blockers)lines.push(`- ${b}`)}return lines.join('\n')}
