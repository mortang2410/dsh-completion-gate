import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import{fileURLToPath}from'node:url';import{CompletionGateService}from'../lib/index.js'
// The first argument is kept for existing call sites and ignored: turn events reach the gate through the session/event hook.
function agent(_events=[],header={cwd:process.cwd()}){const steers=[],followups=[];return{id:'a',session:{header},steer:m=>steers.push(m),followup:m=>followups.push(m),steers,followups}}
const ctx={}

function service(ctx,config={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cg-service-settings-'));const instance=new CompletionGateService(ctx,config,{settingsPath:path.join(dir,'settings.json')});instance.__testSettingsDir=dir;return instance}
function cleanupService(instance){if(instance?.__testSettingsDir)fs.rmSync(instance.__testSettingsDir,{recursive:true,force:true})}

// The gate started against a stub host. Turn events are published through its session/event hook, the way dsh-session
// publishes them: the session first, then { type, seq, time, data }.
let published=0
function liveService(config={}){const listeners=new Map();const off=()=>()=>{};const host={reflect:{get:()=>undefined},on:(name,listener)=>{listeners.set(name,listener);return off()},provide:off,tools:{register:off},commands:{register:off},systemPrompt:{section:off},webServer:{register:off}};const svc=service(host,config);svc.__listeners=listeners;svc.start();return svc}
function emit(svc,agentRef,type,data){svc.__listeners.get('session/event')({id:agentRef.id},{type,seq:++published,time:Date.now(),data})}

test('matches screenshot-style pending action',()=>{const svc=liveService();const a=agent();emit(svc,a,'assistant/message',{turn:1,message:{content:[{type:'text',text:'Now I need the call site, and in parallel start the Exa research.'}]}});emit(svc,a,'tool/call',{turn:1});emit(svc,a,'tool/result',{turn:1});const p=svc.premature(a,1);assert.ok(p,'the guard must fire on pending text');assert.equal(p.futureIntent,true)})
test('does not mistake let me know for pending work',()=>{const svc=liveService();const a=agent();emit(svc,a,'assistant/message',{turn:1,message:{content:[{type:'text',text:'Everything is complete. Let me know if you want changes.'}]}});assert.equal(svc.premature(a,1),null);emit(svc,a,'assistant/message',{turn:2,message:{content:[{type:'text',text:'Next I will inspect the call site.'}]}});assert.ok(svc.premature(a,2),'control: the guard must read the hook events, or the null above proves nothing')})
test('reasoning-only after tools is unfinished',()=>{const svc=liveService();const a=agent();emit(svc,a,'tool/call',{turn:2});emit(svc,a,'tool/result',{turn:2});emit(svc,a,'assistant/message',{turn:2,message:{content:[{type:'reasoning',text:'Huge finding. I should inspect next.'}]}});const p=svc.premature(a,2);assert.ok(p,'the guard must fire on reasoning-only output after tools');assert.equal(p.reasoningOnlyAfterTools,true)})
test('guard is bounded across a recovery chain',()=>{const svc=liveService({prematureStopMaxContinuations:2});const a=agent();emit(svc,a,'assistant/message',{turn:3,message:{content:[{type:'text',text:'Next I will inspect the call site.'}]}});assert.ok(svc.premature(a,3));emit(svc,a,'assistant/message',{turn:4,message:{content:[{type:'text',text:'I still need to trace the caller.'}]}});assert.ok(svc.premature(a,4));emit(svc,a,'assistant/message',{turn:5,message:{content:[{type:'text',text:'Next I will inspect the route.'}]}});assert.equal(svc.premature(a,5),null)})
test('the guard reads the session/event hook, never a session event array',()=>{const svc=liveService();const a=agent();a.session.events=[{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'Next I will inspect it.'}]}}}];assert.equal(svc.premature(a,1),null)})
test('no file under lib reads session events through snapshotEvents or session.events',()=>{const lib=fileURLToPath(new URL('../lib/',import.meta.url));for(const name of fs.readdirSync(lib)){if(!name.endsWith('.js'))continue;const text=fs.readFileSync(path.join(lib,name),'utf8');assert.doesNotMatch(text,/snapshotEvents/,`${name} reads the session log through snapshotEvents`);assert.doesNotMatch(text,/session\.events/,`${name} reads session.events`)}})
test('subagents are skipped by default',()=>{const s=service(ctx,{});const a=agent([],{cwd:process.cwd(),parentSession:'parent',delegationDepth:1});assert.equal(s.applies(a),false)})
test('root agents are gated',()=>{const s=service(ctx,{});assert.equal(s.applies(agent()),true)})

test('turn-stopping schedules a fresh follow-up for screenshot-style unfinished root turn',async()=>{
 const svc=liveService({autoDetectChecks:false,requireTests:false});const a=agent();
 emit(svc,a,'turn/start',{turn:11});
 emit(svc,a,'assistant/message',{turn:11,message:{content:[{type:'text',text:'Now I need the call site to see where each value comes from, and in parallel start the Exa research you asked for.'}]}});
 emit(svc,a,'tool/call',{turn:11,name:'grep'});
 emit(svc,a,'tool/result',{turn:11});
 emit(svc,a,'assistant/message',{turn:11,message:{content:[{type:'reasoning',text:'HUGE finding from the Exa research.'}]}});
 await svc.stopping({agent:a,turn:11,signal:new AbortController().signal});
 assert.equal(a.steers.length,0);
 assert.equal(a.followups.length,1);
 assert.match(a.followups[0].content[0].text,/PREMATURE STOP RECOVERY/);
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
 const svc=liveService({autoDetectChecks:false,requireTests:false,prematureStopMaxContinuations:3})
 const a=agent()
 emit(svc,a,'assistant/message',{turn:1,message:{content:[{type:'text',text:'Now I need to inspect the call site.'}]}})
 await svc.stopping({agent:a,turn:1,signal:new AbortController().signal})
 assert.equal(a.followups.length,1)
 emit(svc,a,'assistant/message',{turn:2,message:{content:[]}})
 await svc.stopping({agent:a,turn:2,signal:new AbortController().signal})
 assert.equal(a.followups.length,2)
 assert.match(a.followups[1].content[0].text,/returned no useful assistant content/)
})

test('an out-of-range port is refused before any phase runs or any probe is sent', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-port-')))
  const s = service(ctx, {})
  try {
    // The start command writes a marker, so the marker exists only if the start phase ran.
    const marker = path.join(dir, 'started')
    fs.mkdirSync(path.join(dir, '.dsh'))
    const start = `node -e "require('fs').writeFileSync('${marker}','x')"`
    fs.writeFileSync(path.join(dir, '.dsh', 'environment.json'), JSON.stringify({ version: 1, recipe: { name: 'port-check', kind: 'node', start, port: 8000 } }))
    for (const port of [70000, -1, 3000.5, 0]) {
      const outcome = await s.recipe(agent([], { cwd: dir }), { port })
      assert.equal(outcome.ok, false, `port ${port} was accepted`)
      assert.match(outcome.blockers.join(' '), /port must be an integer from 1 to 65535/, `port ${port} was refused without a port reason`)
      assert.equal(fs.existsSync(marker), false, `port ${port} launched the start command before it was refused`)
    }
  } finally {
    cleanupService(s)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('normal recovery response clears the continuation chain',()=>{
 const svc=liveService({prematureStopMaxContinuations:3})
 const a=agent()
 emit(svc,a,'assistant/message',{turn:1,message:{content:[{type:'text',text:'Next I will inspect it.'}]}})
 assert.ok(svc.premature(a,1))
 emit(svc,a,'assistant/message',{turn:2,message:{content:[{type:'text',text:'Investigation complete. The defect is fixed and verified.'}]}})
 assert.equal(svc.premature(a,2),null)
 assert.equal(svc.state(a).continuationBlocks,0)
 assert.equal(svc.state(a).recoveryPending,false)
})

// One finished turn: its events arrive through the session/event hook, the final assistant message last.
function finalTurn(svc,a,turn,content,{tool=false}={}){emit(svc,a,'turn/start',{turn});if(tool){emit(svc,a,'tool/call',{turn,name:'bash'});emit(svc,a,'tool/result',{turn})}emit(svc,a,'assistant/message',{turn,message:{role:'assistant',content}});emit(svc,a,'turn/end',{turn})}

test('a finished answer that tells the user to run a command is not pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'All changes are in place and the tests pass. To apply them locally, you need to run the build again.'}],{tool:true});assert.equal(svc.premature(a,1),null)})
test('a finished answer with a next-step line for the user is not pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'The parser fix is in place and the tests pass.\nNext step: publish the release notes after review.'}],{tool:true});assert.equal(svc.premature(a,1),null)})
test('a finished report that says work ran in parallel is not pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'I ran lint and tests in parallel; both pass. The change is complete.'}],{tool:true});assert.equal(svc.premature(a,1),null)})
test('an in-parallel action the model has not taken yet is pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'The fix is in place, and in parallel start the lint run.'}],{tool:true});assert.ok(svc.premature(a,1),'the guard must fire on a pending in-parallel action')})
test('a next-step line with an imperative is advice, not pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'The fix is in place.\nNext step: run the tests.'}],{tool:true});assert.equal(svc.premature(a,1),null)})
test('a we-need-to line in a finished answer is advice, not pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'The fix is in place. We need to run the tests again.'}],{tool:true});assert.equal(svc.premature(a,1),null)})
test('pending work the model states in its own words still blocks without tools',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'I will run the tests next.'}]);assert.ok(svc.premature(a,1),'the guard must fire on I will run next')})
test('reasoning that says I need to check does not block a complete answer without tools',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'reasoning',text:'The answer is clear. I need to check nothing else changed, so this is complete.'},{type:'text',text:'The answer is 42, and the change is complete.'}]);assert.equal(svc.premature(a,1),null)})
test('reasoning that says I need to check does not block a complete answer after tools',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'reasoning',text:'I need to check the config.'},{type:'text',text:'The config is correct and the change is complete.'}],{tool:true});assert.equal(svc.premature(a,1),null)})
test('reasoning only after tools still blocks',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'reasoning',text:'Looks plausible so far.'}],{tool:true});const p=svc.premature(a,1);assert.ok(p,'the guard must fire on reasoning-only output after tools');assert.equal(p.reasoningOnlyAfterTools,true)})
test('a but-still need to in a finished answer is pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'The parser is fixed, but still need to run the tests.'}],{tool:true});assert.ok(svc.premature(a,1),'the guard must fire on but still need to run')})
test('a but-still need to after a longer clause is pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'The change is written and reviewed, but still need to run the tests.'}],{tool:true});assert.ok(svc.premature(a,1),'the guard must fire on but still need to run after a clause')})
test('an and-need-to after a finished clause is pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'The parser is fixed and need to check the call site.'}],{tool:true});assert.ok(svc.premature(a,1),'the guard must fire on and need to check')})
test('a sentence-initial still need to is pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'Still need to run the tests.'}],{tool:true});assert.ok(svc.premature(a,1),'the guard must fire on Still need to run')})
test('a bulleted need to is pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'Remaining:\n- need to run the tests.'}],{tool:true});assert.ok(svc.premature(a,1),'the guard must fire on a bulleted need to run')})
test('a bulleted still need to is pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'Remaining:\n- still need to run the tests.'}],{tool:true});assert.ok(svc.premature(a,1),'the guard must fire on a bulleted still need to run')})
test('a subjectless need to at the start of a line is pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'The fix is in place and the tests pass.\nNeed to run the migration before deploying.'}],{tool:true});assert.ok(svc.premature(a,1),'the guard must fire on a subjectless Need to run')})
test('a first-person next step with I will and a work verb is pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'The fix is in place.\nNext step: I will run the build again.'}],{tool:true});assert.ok(svc.premature(a,1),'the guard must fire on Next step: I will run')})
test('a first-person need to after a complete change is pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'All changes are in place. I need to run the tests again.'}],{tool:true});assert.ok(svc.premature(a,1),'the guard must fire on I need to run')})
test('a first-person contraction with a work verb is pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:"I'll check the output."}],{tool:true});assert.ok(svc.premature(a,1),"the guard must fire on I'll check")})
test('a first-person let me run is pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'Let me run the tests.'}],{tool:true});assert.ok(svc.premature(a,1),'the guard must fire on Let me run')})
test('an imperative next step after a complete answer is advice, not pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'All changes are in place and the tests pass.\nNext step: run the build again.'}],{tool:true});assert.equal(svc.premature(a,1),null)})
test('a we-need-to advice line after a complete answer is not pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'The fix is in place and the tests pass. We need to run the migration before deploying.'}],{tool:true});assert.equal(svc.premature(a,1),null)})
test('a next step that recommends an action is advice, not pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'The fix is in place and the tests pass.\nNext step: I recommend publishing the release notes after review.'}],{tool:true});assert.equal(svc.premature(a,1),null)})
test('a next step that asks the user to choose is advice, not pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'The fix is in place and the tests pass.\nNext step: let me know which option you want.'}],{tool:true});assert.equal(svc.premature(a,1),null)})
test('a next step with we will publish is advice, not pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'The fix is in place and the tests pass.\nNext step: we will publish after review.'}],{tool:true});assert.equal(svc.premature(a,1),null)})
test('a next step with I will leave the work to the user is advice, not pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'The fix is in place and the tests pass.\nNext step: I will leave the release notes to you.'}],{tool:true});assert.equal(svc.premature(a,1),null)})
test('a comma-joined still need to is pending work',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'The parser is fixed, still need to run the tests.'}],{tool:true});assert.ok(svc.premature(a,1),'the guard must fire on a comma-joined still need to run')})
test('reasoning-only output with no tool call before it that says I need to check passes',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'reasoning',text:'I need to check the config.'}]);assert.equal(svc.premature(a,1),null)})
test('reasoning-only output with no tool call before it that says I will run next passes',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'reasoning',text:'I will run the tests next.'}]);assert.equal(svc.premature(a,1),null)})
