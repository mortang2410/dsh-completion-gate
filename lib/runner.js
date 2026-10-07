import { execFile, exec as execShell } from 'node:child_process'
import { promisify } from 'node:util'
import { addedLinesFromDiff, detectChecks, redactText, scanSecurity, scanTodos } from './core.js'
const execFileP=promisify(execFile),execShellP=promisify(execShell)
async function git(cwd,args,timeout=30000){try{const{stdout,stderr}=await execFileP('git',args,{cwd,timeout,maxBuffer:20*1024*1024,windowsHide:true});return{ok:true,stdout:String(stdout||''),stderr:String(stderr||'')}}catch(e){return{ok:false,stdout:String(e?.stdout||''),stderr:String(e?.stderr||e?.message||'')}}}

// Git still locates the project root, which is where the canonical checks run. It no longer
// decides what changed: the host's turn-scoped change record owns that decision.
export async function projectRoot(cwd){const root=await git(cwd,['rev-parse','--show-toplevel']);return root.ok&&root.stdout.trim()?root.stdout.trim():cwd}

// The added lines of the turn's own diff. The recorder serves the turn-start and turn-end
// contents of every file it listed, so the scans read exactly what this turn added, including
// through a shell command, and never another session's pre-existing dirt. Hunk lines already
// carry their `+`, `-` or space prefix, so they feed addedLinesFromDiff unchanged.
export async function addedLinesForRecord(service,sessionId,seq,fileCount,signal){
  const lines=[],gaps=[]
  for(let index=0;index<fileCount;index+=1){
    let diff
    try{diff=await service.diff(sessionId,seq,index,signal)}
    catch(error){gaps.push(`file #${index}: ${String(error?.message||error)}`);continue}
    if(!diff||diff.kind!=='text'||!Array.isArray(diff.hunks))continue
    lines.push(...addedLinesFromDiff(diff.hunks.flatMap(hunk=>hunk.lines||[]).join('\n')))
  }
  return{lines,gaps}
}

async function runCheck(check,cwd,c,signal){const start=Date.now();try{const{stdout,stderr}=await execShellP(check.command,{cwd,timeout:c.commandTimeoutMs,maxBuffer:20*1024*1024,windowsHide:true,shell:process.platform==='win32'?'cmd.exe':'/bin/sh',...(signal?{signal}:{})});return{...check,pass:true,durationMs:Date.now()-start,output:redactText(`${stdout||''}${stderr?`\n${stderr}`:''}`,cwd,c.maxOutputChars)}}catch(e){return{...check,pass:false,durationMs:Date.now()-start,output:redactText(`${e?.stdout||''}${e?.stderr?`\n${e.stderr}`:`\n${e?.message||e}`}`,cwd,c.maxOutputChars)}}}

// The machine layer. `ws` carries the turn-scoped record resolved by the gate:
//   { root, label, turn, seq, determined, recordMissing, files, documentationOnly, addedLines, diffGaps }
//
// Two kinds of finding are kept apart, because only one of them can be covered by other
// evidence:
//   hardBlockers  - real failures: an undetermined change record, a failed required check, a
//                   new TODO marker, a credential pattern. Nothing covers these; they must be fixed.
//   missingTestCommand - the project has no executable test command. This is a statement about
//                   the available harness, not a failure, so the completion layer lets a fresh
//                   passing recipe or temporary verifier cover it. It is still computed and
//                   reported here exactly as it was before that evidence existed.
// A turn whose every changed path is documentation runs no behavioral check and is not asked for
// a test command, but the added-line TODO and credential scans still read its diff.
export async function runMachineGate(ws,c,signal){const checks=ws.documentationOnly?[]:detectChecks(ws.root,c);const results=[];for(const check of checks)results.push(await runCheck(check,ws.root,c,signal));const added=ws.addedLines||[];const todoHits=c.blockNewTodos?scanTodos(added):[],securityHits=c.securityScan?scanSecurity(added):[],hardBlockers=[];if(!ws.determined)hardBlockers.push(ws.reason||'The files this turn changed cannot be determined.');for(const r of results)if(r.required&&!r.pass)hardBlockers.push(`${r.name} failed.`);if(todoHits.length)hardBlockers.push(`${todoHits.length} new TODO/FIXME/HACK/XXX marker(s) detected.`);if(securityHits.length)hardBlockers.push(`${securityHits.length} obvious security-risk pattern(s) detected in added code.`);const missingTestCommand=!ws.documentationOnly&&c.requireTests&&!results.some(r=>r.category==='test')?`No executable test command was detected for this project.`:null;return{fingerprint:ws.fingerprint,workspaceLabel:ws.label,changedFiles:ws.files,turn:ws.turn,recordSeq:ws.seq,changesDetermined:ws.determined,documentationOnly:ws.documentationOnly,diffGaps:ws.diffGaps||[],checks:results,todoHits,securityHits,hardBlockers,missingTestCommand,blockers:[...hardBlockers,...(missingTestCommand?[missingTestCommand]:[])],machinePass:!hardBlockers.length&&!missingTestCommand,generatedAt:Date.now()}}
