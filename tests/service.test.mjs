import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import{CompletionGateService,turnEvidence}from'../lib/index.js'
function agent(events=[],header={cwd:process.cwd()}){const steers=[],followups=[];return{id:'a',session:{header,events},steer:m=>steers.push(m),followup:m=>followups.push(m),steers,followups}}
const ctx={}

function service(ctx,config={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cg-service-settings-'));const instance=new CompletionGateService(ctx,config,{settingsPath:path.join(dir,'settings.json')});instance.__testSettingsDir=dir;return instance}
function cleanupService(instance){if(instance?.__testSettingsDir)fs.rmSync(instance.__testSettingsDir,{recursive:true,force:true})}
test('matches screenshot-style pending action',()=>{const a=agent([{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'Now I need the call site, and in parallel start the Exa research.'}]}}},{type:'tool/call',data:{turn:1}},{type:'tool/result',data:{turn:1}}]);assert.equal(turnEvidence(a,1).futureIntent,true)})
test('does not mistake let me know for pending work',()=>{const a=agent([{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'Everything is complete. Let me know if you want changes.'}]}}}]);assert.equal(turnEvidence(a,1).futureIntent,false)})
test('reasoning-only after tools is unfinished',()=>{const a=agent([{type:'tool/call',data:{turn:2}},{type:'tool/result',data:{turn:2}},{type:'assistant/message',data:{turn:2,message:{content:[{type:'reasoning',text:'Huge finding. I should inspect next.'}]}}}]);assert.equal(turnEvidence(a,2).reasoningOnlyAfterTools,true)})
test('guard is bounded across a recovery chain',()=>{const s=service(ctx,{prematureStopMaxContinuations:2});const a=agent([{type:'assistant/message',data:{turn:3,message:{content:[{type:'text',text:'Next I will inspect the call site.'}]}}}]);assert.ok(s.premature(a,3));a.session.events=[{type:'assistant/message',data:{turn:4,message:{content:[{type:'text',text:'I still need to trace the caller.'}]}}}];assert.ok(s.premature(a,4));a.session.events=[{type:'assistant/message',data:{turn:5,message:{content:[{type:'text',text:'Next I will inspect the route.'}]}}}];assert.equal(s.premature(a,5),null)})
test('subagents are skipped by default',()=>{const s=service(ctx,{});const a=agent([],{cwd:process.cwd(),parentSession:'parent',delegationDepth:1});assert.equal(s.applies(a),false)})
test('root agents are gated',()=>{const s=service(ctx,{});assert.equal(s.applies(agent()),true)})

test('turn-stopping schedules a fresh follow-up for screenshot-style unfinished root turn',async()=>{
 const a=agent([
  {type:'assistant/message',data:{turn:11,message:{content:[{type:'text',text:'Now I need the call site to see where each value comes from, and in parallel start the Exa research you asked for.'}]}}},
  {type:'tool/call',data:{turn:11,name:'grep'}},
  {type:'tool/result',data:{turn:11}},
  {type:'assistant/message',data:{turn:11,message:{content:[{type:'reasoning',text:'HUGE finding from the Exa research.'}]}}}
 ])
 const s=service(ctx,{autoDetectChecks:false,requireTests:false})
 await s.stopping({agent:a,turn:11,signal:new AbortController().signal})
 assert.equal(a.steers.length,0)
 assert.equal(a.followups.length,1)
 assert.match(a.followups[0].content[0].text,/PREMATURE STOP RECOVERY/)
})

test('turn-stopping leaves subagent lifecycle untouched by default',async()=>{
 const a=agent([{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'Now I need to inspect next.'}]}}}],{cwd:process.cwd(),parentSession:'root',delegationDepth:1})
 const s=service(ctx,{})
 await s.stopping({agent:a,turn:1,signal:new AbortController().signal})
 assert.equal(a.steers.length,0)
 assert.equal(a.followups.length,0)
})


test('operator settings persist, apply live, and reset to profile defaults',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cg-settings-live-'));try{const file=path.join(dir,'settings.json');const first=new CompletionGateService(ctx,{mode:'strict',gateSubagents:false},{settingsPath:file});first.updateSettings({mode:'advisory',gateSubagents:true,requireTests:false});assert.equal(first.config.mode,'advisory');assert.equal(first.config.gateSubagents,true);const second=new CompletionGateService(ctx,{mode:'strict',gateSubagents:false},{settingsPath:file});assert.equal(second.config.mode,'advisory');assert.equal(second.config.requireTests,false);second.resetSettings();assert.equal(second.config.mode,'strict');assert.equal(second.config.gateSubagents,false);assert.equal(fs.existsSync(file),false)}finally{fs.rmSync(dir,{recursive:true,force:true})}})

test('changing policy invalidates cached evidence, attestations, and overrides',()=>{const s=service(ctx,{});try{const state=s.state(agent());state.cached.set('fp',{pass:true});state.attestation={fingerprint:'fp'};state.override={fingerprint:'fp'};state.lastReport={pass:true};s.updateSettings({securityScan:false});assert.equal(state.cached.size,0);assert.equal(state.attestation,null);assert.equal(state.override,null);assert.equal(state.lastReport,null)}finally{cleanupService(s)}})

async function apiCall(service, method, url, body) {
  const { Readable } = await import('node:stream')
  const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  req.headers = { host: 'localhost:8080', origin: 'http://localhost:8080', 'sec-fetch-site': 'same-origin' }
  let status = 0, payload = ''
  const res = { writeHead(code) { status = code }, end(text = '') { payload += text } }
  await service.handleApi(req, res)
  return { status, body: JSON.parse(payload) }
}

test('settings API saves live policy and reset endpoint restores profile defaults', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-api-settings-'))
  try {
    const file = path.join(dir, 'settings.json')
    const svc = new CompletionGateService(ctx, { mode: 'strict', requireTests: true }, { settingsPath: file })
    let response = await apiCall(svc, 'POST', '/api/completion-gate/v1/settings', { settings: { mode: 'advisory', requireTests: false } })
    assert.equal(response.status, 200)
    assert.equal(response.body.settings.mode, 'advisory')
    assert.equal(response.body.settings.requireTests, false)
    assert.equal(fs.existsSync(file), true)
    response = await apiCall(svc, 'POST', '/api/completion-gate/v1/settings/reset', {})
    assert.equal(response.status, 200)
    assert.equal(response.body.settings.mode, 'strict')
    assert.equal(response.body.settings.requireTests, true)
    assert.equal(fs.existsSync(file), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})


test('empty recovery turn is retried with another bounded follow-up',async()=>{
 const s=service(ctx,{autoDetectChecks:false,requireTests:false,prematureStopMaxContinuations:3})
 const a=agent([{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'Now I need to inspect the call site.'}]}}}])
 await s.stopping({agent:a,turn:1,signal:new AbortController().signal})
 assert.equal(a.followups.length,1)
 a.session.events=[{type:'assistant/message',data:{turn:2,message:{content:[]}}}]
 await s.stopping({agent:a,turn:2,signal:new AbortController().signal})
 assert.equal(a.followups.length,2)
 assert.match(a.followups[1].content[0].text,/returned no useful assistant content/)
})

test('normal recovery response clears the continuation chain',()=>{
 const s=service(ctx,{prematureStopMaxContinuations:3})
 const a=agent([{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'Next I will inspect it.'}]}}}])
 assert.ok(s.premature(a,1))
 a.session.events=[{type:'assistant/message',data:{turn:2,message:{content:[{type:'text',text:'Investigation complete. The defect is fixed and verified.'}]}}}]
 assert.equal(s.premature(a,2),null)
 assert.equal(s.state(a).continuationBlocks,0)
 assert.equal(s.state(a).recoveryPending,false)
})
