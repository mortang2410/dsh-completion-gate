// Configuration and the pure helpers the tracker and the stop path share. Nothing here starts a process or reads a
// verification result.

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  gateSubagents: false,
  preventPrematureStops: true,
  prematureStopMaxContinuations: 3,
  securityScan: true,
  maxChangedFiles: 500,
  verificationNudgeLimit: 3,
})

export function resolveConfig(config = {}) {
  const bool = key => typeof config[key] === 'boolean' ? config[key] : DEFAULT_CONFIG[key]
  const int = (key, min, max) => Number.isFinite(config[key]) ? Math.min(max, Math.max(min, Math.floor(config[key]))) : DEFAULT_CONFIG[key]
  return {
    enabled:bool('enabled'), gateSubagents:bool('gateSubagents'),
    preventPrematureStops:bool('preventPrematureStops'), prematureStopMaxContinuations:int('prematureStopMaxContinuations',0,20),
    securityScan:bool('securityScan'), maxChangedFiles:int('maxChangedFiles',10,5000), verificationNudgeLimit:int('verificationNudgeLimit',0,20),
  }
}

export function cleanText(value,max=4000){let text='';try{text=String(value??'')}catch{return ''}return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,'').slice(0,max)}
// Input is host hunk text: each line keeps its own prefix ('+' added, '-' removed, space for context)
// and no git file headers are present, so a line beginning with '++' is an added line whose text
// begins with '+'.
export function addedLinesFromDiff(diff){return String(diff||'').split(/\r?\n/).filter(l=>l.startsWith('+')).map(l=>l.slice(1))}

// The added lines of the turn's own diff. The recorder serves the turn-start and turn-end
// contents of every file it listed, so the scans read exactly what this turn added, including
// through a shell command, and never another session's pre-existing dirt. Hunk lines already
// carry their `+`, `-` or space prefix, so they feed addedLinesFromDiff unchanged.
// A file the host serves as binary or oversized has no lines to scan, so it is a gap, as a read that
// throws is. An undefined diff means the host holds no record of the file; it is not reported here.
export async function addedLinesForRecord(service,sessionId,seq,fileCount,signal){
  const lines=[],gaps=[]
  for(let index=0;index<fileCount;index+=1){
    let diff
    try{diff=await service.diff(sessionId,seq,index,signal)}
    catch(error){gaps.push(`file #${index}: ${String(error?.message||error)}`);continue}
    if(!diff)continue
    if(diff.kind!=='text'||!Array.isArray(diff.hunks)){gaps.push(`${diff.display}: ${diff.kind}`);continue}
    lines.push(...addedLinesFromDiff(diff.hunks.flatMap(hunk=>hunk.lines||[]).join('\n')))
  }
  return{lines,gaps}
}

const SECURITY_RULES=[['hardcoded-secret',/(?:api[_-]?key|password|passwd|secret|access[_-]?token)\s*[:=]\s*["'][^"']{8,}["']/i,'Possible hard-coded credential or secret'],['tls-js',/rejectUnauthorized\s*:\s*false/i,'TLS certificate verification disabled'],['tls-py',/verify\s*=\s*False\b/i,'TLS certificate verification disabled'],['eval',/\beval\s*\(/,'Dynamic eval introduced'],['new-function',/new\s+Function\s*\(/,'Dynamic Function constructor introduced'],['chmod',/chmod\s+(?:-R\s+)?777\b/,'World-writable permissions introduced'],['shell',/shell\s*:\s*true/,'Shell execution enabled; review command construction'],['html',/dangerouslySetInnerHTML\s*=/,'Raw HTML injection surface introduced']]
export function scanSecurity(lines){const hits=[];lines.forEach((line,i)=>{for(const[id,re,message]of SECURITY_RULES)if(re.test(line))hits.push({id,line:i+1,message,text:cleanText(line.trim(),300)})});return hits.slice(0,100)}
