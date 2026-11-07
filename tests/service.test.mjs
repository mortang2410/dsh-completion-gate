import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';import{execFileSync}from'node:child_process';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import{fileURLToPath}from'node:url';import{CompletionGateService}from'../lib/index.js'
// The first argument is kept for existing call sites and ignored: turn events reach the gate through the session/event hook.
function agent(_events=[],header={cwd:process.cwd()}){const steers=[],followups=[];return{id:'a',session:{header},steer:m=>steers.push(m),followup:m=>followups.push(m),steers,followups}}
const ctx={}

function service(ctx,config={},root=os.tmpdir()){fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'cg-service-settings-'));const instance=new CompletionGateService(ctx,config,{settingsPath:path.join(dir,'settings.json')});instance.__testSettingsDir=dir;return instance}
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
test('ACCEPT-H6: an in-parallel action passes when the verb comes first',()=>{const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text:'Start the lint run in parallel with the tests.'}],{tool:true});assert.equal(svc.premature(a,1),null,'ACCEPT-H6: the guard reads "in parallel" only when a work verb comes directly after it, so this word order passes')})
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

// Revert of the review-loop guard widening (d7957c4, a67b88b, cb6c0de, 50bc46d; reviewer finding N7-1
// and decision D1). Those commits replaced the fixed phrase and verb lists with a rule that blocked
// whatever verb followed a first-person form. Every sentence below blocked on 05f6ae2 and passed at the
// pre-loop reference 851656f; after the revert they must pass again. The first test fails on 05f6ae2.
test('revert: the widened first-person forms no longer block',()=>{const widened=["The fix is in place and the tests pass. I will publish the release notes after review.","The fix is in place and the tests pass. I'm using the existing helper.","The fix is in place and the tests pass. I have to run the tests before merging.","The fix is in place. I should check the call site.","The fix is in place and the tests pass.\nI'll wait for the build to finish.","The fix is in place and the tests pass. I'll note the caveat.","The fix is in place and the tests pass. I'll leave the migration running and check the result.","The fix is in place and the tests pass. I'll be noting the caveat.","All changes are in place and the tests pass.\nNext step: I am going to run the build again.","The fix is in place and the tests pass. I'll recommend a fix and then run the tests.","The fix is in place and the tests pass. I'm noticing the caveat.","The fix is in place and the tests pass. I would like to run the migration next."];for(const text of widened){const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text}],{tool:true});assert.equal(svc.premature(a,1),null,`the guard must not block this sentence after the revert: ${text}`)}})
test('revert: the pre-loop pending-work patterns still block',()=>{const blocking=["Now I need the call site, and in parallel start the Exa research.","Next I will inspect the call site.","I'll check the output.","Let me run the tests.","Still need to run the tests.","I need to run the tests again.","The fix is in place, and in parallel start the lint run."];for(const text of blocking){const svc=liveService();const a=agent();finalTurn(svc,a,1,[{type:'text',text}],{tool:true});assert.ok(svc.premature(a,1),`the guard must still fire: ${text}`)}})

// Repositories section of the status action. A stub host carries a change recorder and captures the tool the gate
// registers, so a test can call its execute. Status must never start a check, so each test spies on the run seam.
// Test workspaces live under the task's Trash root, never the system temporary directory (AGENTS.md).
const workRoot=path.join(os.homedir(),'Trash','3t34-tests')
function makeWorkDir(prefix){fs.mkdirSync(workRoot,{recursive:true});return fs.realpathSync(fs.mkdtempSync(path.join(workRoot,prefix)))}
function tempPlainDir(t){const dir=makeWorkDir('plain-');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir}
function tempGitRepo(t){const dir=makeWorkDir('status-');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));execFileSync('git',['init','-q','.'],{cwd:dir});fs.writeFileSync(path.join(dir,'app.js'),'const value = 1\n');return dir}
function statusService(summaries,config={}){const listeners=new Map();const tools={};const commands={};const off=()=>()=>{};const reflect=summaries?{get:name=>name==='workspaceChanges'?{summary:(id,seq)=>summaries.get(`${id}:${seq}`)}:undefined}:{get:()=>undefined};const host={reflect,on:(name,listener)=>{listeners.set(name,listener);return off()},provide:off,tools:{register:definition=>{tools.completion_gate=definition;return off()}},commands:{register:definition=>{commands[definition.name]=definition;return off()}},systemPrompt:{section:off},webServer:{register:off}};const svc=service(host,config,workRoot);svc.__listeners=listeners;svc.start();svc.__tool=tools.completion_gate;svc.__commands=commands;return svc}
// One turn as the host publishes it: the turn starts, then its change record is announced under a sequence number that keys the summary.
function announceTurn(svc,a,summaries,turn,cwd,paths){emit(svc,a,'turn/start',{turn});const seq=published+1;summaries.set(`${a.id}:${seq}`,{turn,cwd,files:paths.map(p=>({path:p,display:p,added:1,deleted:0})),total:paths.length,added:paths.length,deleted:0});emit(svc,a,'workspace/changes',{turn});return seq}

test('status lists every repository the session changed, each with its catalog path and files', async t => {
  const session = tempGitRepo(t)
  const sibling = tempGitRepo(t)
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const a = agent([], { cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['app.js', path.join(sibling, 'app.js')])
  const result = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: new AbortController().signal })
  const lines = result.markdown.split('\n')
  assert.equal(lines.filter(line => line.startsWith('### ')).length, 2, result.markdown)
  assert.doesNotMatch(result.markdown, /outside any git repository/, 'a git session carries no coverage notice')
  for (const repo of [session, sibling]) {
    assert.ok(lines.includes(`Root: ${repo}`), `missing root line for ${repo}`)
    assert.ok(lines.includes(`Catalog: ${path.join(repo, '.dsh', 'verification.json')}`), `missing catalog line for ${repo}`)
    assert.ok(lines.includes(`- ${path.join(repo, 'app.js')} (unclaimed)`), `missing file line under ${repo}`)
  }
})

// A check runs only through run(). The spy throws instead of calling through, so a status that reached a check
// fails here and no check executes.
test('status starts no check: the run seam is never called', async t => {
  const session = tempGitRepo(t)
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const run = t.mock.method(svc, 'run', async () => { throw new Error('status must not call run') })
  const a = agent([], { cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['app.js'])
  const result = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: new AbortController().signal })
  assert.equal(run.mock.callCount(), 0)
  assert.equal(result.pass, null, 'status with no earlier run reports no machine result')
  assert.match(result.markdown, /status executes none/)
})

test('the gate-status command shows the repositories and starts no check', async t => {
  const session = tempGitRepo(t)
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const run = t.mock.method(svc, 'run', async () => { throw new Error('gate-status must not call run') })
  const a = agent([], { cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['app.js'])
  const result = await svc.__commands['gate-status'].handler({ agent: a, rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.equal(run.mock.callCount(), 0)
  const lines = result.text.split('\n')
  assert.ok(lines.includes(`Root: ${session}`), result.text)
  assert.ok(lines.includes(`Catalog: ${path.join(session, '.dsh', 'verification.json')}`), `missing catalog line: ${result.text}`)
  assert.ok(lines.includes(`- ${path.join(session, 'app.js')} (unclaimed)`), `missing file line: ${result.text}`)
})

// The spec says /gate and /gate-status show the same report, so /gate carries the repositories section as status does.
// The check seam is stubbed with a fixed report, so no project check runs.
test('the gate command shows the repositories section too, as the status command does', async t => {
  const session = tempGitRepo(t)
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const run = t.mock.method(svc, 'run', async () => ({ pass: true, turn: 1, recordSeq: 1, workspaceLabel: 'test', checks: [], blockers: [] }))
  const a = agent([], { cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['app.js'])
  const result = await svc.__commands.gate.handler({ agent: a, rawInput: '' })
  assert.equal(run.mock.callCount(), 1)
  assert.equal(result.kind, 'success')
  const lines = result.text.split('\n')
  assert.ok(lines.includes(`Root: ${session}`), result.text)
  assert.ok(lines.includes(`Catalog: ${path.join(session, '.dsh', 'verification.json')}`), `missing catalog line: ${result.text}`)
  assert.ok(lines.includes(`- ${path.join(session, 'app.js')} (unclaimed)`), `missing file line: ${result.text}`)
})

test('status fixtures keep their settings directory under the task root, not the system temporary directory', t => {
  const svc = statusService(new Map())
  t.after(() => cleanupService(svc))
  assert.ok(svc.__testSettingsDir.startsWith(`${workRoot}${path.sep}`), `settings directory ${svc.__testSettingsDir} is outside ${workRoot}`)
})

// Characterization, not a red test: the comment that said no git process starts was false, and this pins the status
// path for a changed nested repository, which reads that repository's HEAD through git. The run seam must stay unused.
test('a changed nested repository is read by status without starting a check', async t => {
  const session = tempGitRepo(t)
  const nested = path.join(session, 'vendor')
  fs.mkdirSync(nested)
  execFileSync('git', ['init', '-q', '.'], { cwd: nested })
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const run = t.mock.method(svc, 'run', async () => { throw new Error('status must not call run') })
  const a = agent([], { cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['vendor'])
  const result = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: new AbortController().signal })
  assert.equal(run.mock.callCount(), 0)
  assert.ok(result.markdown.includes(`Root: ${nested}`), result.markdown)
})

// A file filed under the outer repository moves to a nested repository that appears after the file was filed, and keeps the
// claim this session made on it. The trigger is a nested .git created during the session. Status does not re-file a turn, so
// only the owner pass on every report can move the file.
test('a file filed under an outer repository moves to a nested repository created later, keeping its claim', async t => {
  const session = tempGitRepo(t)
  const nested = path.join(session, 'pkg')
  fs.mkdirSync(nested)
  const file = path.join(nested, 'source.js')
  fs.writeFileSync(file, 'export const value = 1\n')
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const a = agent([], { cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['pkg/source.js'])
  await svc.__tool.execute({ action: 'status' }, execOf(a))
  svc.repositories.session(a.id).repos.get(session).files.get(file).claim = 'mine'
  execFileSync('git', ['init', '-q', '.'], { cwd: nested })
  await svc.__tool.execute({ action: 'status' }, execOf(a))
  const owners = svc.repositories.repositories(a.id).flatMap(repo => repo.files.map(entry => ({ root: repo.root, absolute: entry.absolute, claim: entry.claim })))
  assert.deepEqual(owners, [{ root: nested, absolute: file, claim: 'mine' }])
})

// The same move through a staged call. Attest and register run their report on a staged copy whose merged-turn map starts
// empty, so the old turn is filed again inside the copy while the outer copy still holds the file. The adopted state must
// hold the file under the nested root only, with the claim the outer copy held.
test('a staged call after a nested repository appears leaves a file under the nested root only', async t => {
  const session = tempGitRepo(t)
  const nested = path.join(session, 'pkg')
  fs.mkdirSync(nested)
  const file = path.join(nested, 'source.js')
  fs.writeFileSync(file, 'export const value = 1\n')
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const a = agent([], { cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['pkg/source.js'])
  await svc.__tool.execute({ action: 'status' }, execOf(a))
  svc.repositories.session(a.id).repos.get(session).files.get(file).claim = 'mine'
  execFileSync('git', ['init', '-q', '.'], { cwd: nested })
  await svc.__tool.execute({ action: 'register', repository_root: nested, items: [{ name: 'Unit', proves: 'source.js sets value' }] }, execOf(a))
  const owners = svc.repositories.repositories(a.id).flatMap(repo => repo.files.map(entry => ({ root: repo.root, absolute: entry.absolute, claim: entry.claim })))
  assert.deepEqual(owners, [{ root: nested, absolute: file, claim: 'mine' }])
})

test('a session outside any git repository gets a notice that its change record covers file-tool edits only', async t => {
  const plain = tempPlainDir(t)
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const a = agent([], { cwd: plain })
  emit(svc, a, 'turn/start', { turn: 1 })
  emit(svc, a, 'turn/end', { turn: 1 })
  const result = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: new AbortController().signal })
  assert.match(result.markdown, /^Notice: The session's working directory is outside any git repository, so the host change record lists file-tool edits only/m, result.markdown)
})

test('two evaluations keep one entry for a file and refresh its content key', async t => {
  const session = tempGitRepo(t)
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const a = agent([], { cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['app.js'])
  const first = await svc.repositoryReport(a)
  assert.equal(first.repositories.length, 1)
  assert.equal(first.repositories[0].files.length, 1)
  fs.writeFileSync(path.join(session, 'app.js'), 'const value = 2\n')
  announceTurn(svc, a, summaries, 2, session, ['app.js'])
  const second = await svc.repositoryReport(a)
  assert.equal(second.repositories.length, 1)
  assert.equal(second.repositories[0].files.length, 1, 'the same file must keep one entry')
  const expected = `file:${crypto.createHash('sha256').update('const value = 2\n').digest('hex')}`
  assert.equal(second.repositories[0].files[0].key, expected)
  assert.notEqual(second.repositories[0].files[0].key, first.repositories[0].files[0].key)
})

// Two reads that overlap for the same turn. The first read starts filing the turn while the second read is still
// waiting on the same record, so the second read must wait for that filing. Both reads must list the repository and its file.
test('overlapping reads of one turn both list its repository and file', async t => {
  const session = tempGitRepo(t)
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const a = agent([], { cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['app.js'])
  const reports = await Promise.all([svc.repositoryReport(a), svc.repositoryReport(a)])
  for (const report of reports) {
    assert.deepEqual(report.repositories.map(repo => repo.root), [session], 'every read must list the repository')
    assert.deepEqual(report.repositories[0].files.map(file => file.absolute), [path.join(session, 'app.js')])
  }
})

test('with no change recorder, the repositories section says the changes cannot be determined', async t => {
  const session = tempGitRepo(t)
  const svc = statusService(null)
  t.after(() => cleanupService(svc))
  const a = agent([], { cwd: session })
  emit(svc, a, 'turn/start', { turn: 1 })
  const result = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: new AbortController().signal })
  const section = result.markdown.slice(result.markdown.indexOf('## Repositories'))
  assert.match(section, /cannot be determined/)
})

test('an earlier turn whose record the host no longer holds is named, even after later turns are read', async t => {
  const session = tempGitRepo(t)
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const a = agent([], { cwd: session })
  const lost = announceTurn(svc, a, summaries, 1, session, ['app.js'])
  summaries.delete(`${a.id}:${lost}`)
  announceTurn(svc, a, summaries, 2, session, [])
  const result = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: new AbortController().signal })
  assert.match(result.markdown, /^Notice: The host change record for turn 1 \(sequence \d+\) is no longer available/m)
})

test('a disposed session forgets its repositories', async t => {
  const session = tempGitRepo(t)
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const a = agent([], { cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['app.js'])
  const before = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: new AbortController().signal })
  assert.match(before.markdown, /^### /m, 'the session must hold a repository before it is disposed')
  svc.__listeners.get('session/disposed')({ id: a.id })
  const after = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: new AbortController().signal })
  assert.doesNotMatch(after.markdown, /^### /m)
})

test('a repository that cannot be read is named in status, and the next status reads the turn again', async t => {
  const session = tempGitRepo(t)
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const real = fs.promises.lstat
  const failing = { on: true }
  t.mock.method(fs.promises, 'lstat', async (target, ...rest) => {
    if (failing.on && String(target).endsWith(`${path.sep}.git`)) {
      const error = new Error('EIO: i/o error')
      error.code = 'EIO'
      throw error
    }
    return real(target, ...rest)
  })
  const a = agent([], { cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['app.js'])
  const first = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: new AbortController().signal })
  assert.match(first.markdown, /^Notice: Attributing the changed files of turn 1 to their repositories failed: EIO: i\/o error/m, first.markdown)
  assert.match(first.markdown, /^Notice: Checking whether the session's working directory is inside a git repository failed: EIO: i\/o error/m, first.markdown)
  assert.doesNotMatch(first.markdown, /^### /m, 'the unreadable turn must not be filed under the session folder')
  failing.on = false
  const second = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: new AbortController().signal })
  assert.ok(second.markdown.includes(`Root: ${session}`), 'the next status must read the turn again')
})

test('status with an earlier machine result keeps that result, adds the repositories after it, and starts no check', async t => {
  const session = tempGitRepo(t)
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const run = t.mock.method(svc, 'run', async () => { throw new Error('status must not call run') })
  const a = agent([], { cwd: session })
  svc.state(a).lastReport = { pass: false, fingerprint: 'fp-earlier', blockers: ['earlier blocker'], workspaceLabel: 'session', turn: 1, recordSeq: 5, checks: [], changedFiles: [] }
  announceTurn(svc, a, summaries, 1, session, ['app.js'])
  const result = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: new AbortController().signal })
  assert.equal(run.mock.callCount(), 0)
  assert.equal(result.pass, false)
  assert.equal(result.fingerprint, 'fp-earlier')
  assert.deepEqual(result.blockers, ['earlier blocker'])
  assert.match(result.markdown, /BLOCKED/)
  assert.ok(result.markdown.indexOf('## Repositories') > result.markdown.indexOf('## Blocking reasons'), 'the repositories section follows the earlier report')
  assert.ok(result.markdown.includes(`Root: ${session}`))
})

// The catalog section of status: each repository's items, one line per item. The item line format is fixed here:
// "- <id>: <name> | Proves: <proves> | Command: <command or none>".
test('status lists the catalog items of two repositories', async t => {
  const session = tempGitRepo(t)
  const sibling = tempGitRepo(t)
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const run = t.mock.method(svc, 'run', async () => { throw new Error('register and status must not call run') })
  const a = agent([], { cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['app.js', path.join(sibling, 'app.js')])
  await svc.__tool.execute({ action: 'register', repository_root: session, items: [{ name: 'Lint', proves: 'No lint errors.' }] }, { agent: a, signal: new AbortController().signal })
  await svc.__tool.execute({ action: 'register', repository_root: sibling, items: [{ name: 'Smoke', proves: 'It starts.', command: 'node smoke.js' }] }, { agent: a, signal: new AbortController().signal })
  const result = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: new AbortController().signal })
  assert.equal(run.mock.callCount(), 0)
  const lines = result.markdown.split('\n')
  assert.ok(lines.includes('- lint: Lint | Proves: No lint errors. | Command: none'), result.markdown)
  assert.ok(lines.includes('- smoke: Smoke | Proves: It starts. | Command: node smoke.js'), result.markdown)
  assert.ok(lines.includes(`Catalog: ${path.join(sibling, '.dsh', 'verification.json')}`), result.markdown)
})

// A repository with no catalog says so. A catalog that cannot be parsed is named as unreadable with its problem, and is
// never listed as an empty catalog, because an empty list would read as a clean repository.
test('status says a repository has no catalog yet, and names an unreadable catalog instead of an empty list', async t => {
  const session = tempGitRepo(t)
  const broken = tempGitRepo(t)
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  const run = t.mock.method(svc, 'run', async () => { throw new Error('status must not call run') })
  const a = agent([], { cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['app.js', path.join(broken, 'app.js')])
  fs.mkdirSync(path.join(broken, '.dsh'))
  fs.writeFileSync(path.join(broken, '.dsh', 'verification.json'), '{"version": 1,')
  const result = await svc.__tool.execute({ action: 'status' }, { agent: a, signal: new AbortController().signal })
  assert.equal(run.mock.callCount(), 0)
  assert.match(result.markdown, /No catalog exists yet/)
  assert.match(result.markdown, /Catalog unreadable, so its items are not listed: the file is not valid JSON/)
  assert.doesNotMatch(result.markdown, /Catalog readable, with no items yet/, 'an unreadable catalog is never shown as readable and empty')
})

// The attest action, driven through the tool the gate registers, so the schema, the root rule, the problem list (the tool's
// blockers), and the status report are the ones a model sees. The fixture registers one catalog item, 'unit'. Its run seam
// throws, so an attest that starts a check fails the test. No tool event is emitted: a claim is believed as reported.
// These fixtures are never deleted by a test: attestRepo makes no t.after removal, as AGENTS.md requires.
function attestRepo() {
  const dir = makeWorkDir('attest-')
  execFileSync('git', ['init', '-q', '.'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'app.js'), 'const value = 1\n')
  return dir
}
const execOf = a => ({ agent: a, signal: new AbortController().signal })
const attestArgs = (session, extra) => ({ action: 'attest', repository_root: session, ...extra })
const completeAttest = session => attestArgs(session, { claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'], items: [{ id: 'unit', state: 'passed' }] })
const linesOf = async (svc, a) => (await svc.__tool.execute({ action: 'status' }, execOf(a))).markdown.split('\n')
async function attestFixture(t, files = ['app.js']) {
  const session = attestRepo()
  for (const file of files) if (!fs.existsSync(path.join(session, file))) fs.writeFileSync(path.join(session, file), 'x\n')
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  t.mock.method(svc, 'run', async () => { throw new Error('attest and status must not call run') })
  const a = agent([], { cwd: session })
  announceTurn(svc, a, summaries, 1, session, files)
  await svc.__tool.execute({ action: 'register', repository_root: session, items: [{ name: 'Unit', proves: 'app.js sets value' }] }, execOf(a))
  return { session, svc, a, summaries }
}

test('attest stores mine and not-mine claims and item states, and status shows them', async t => {
  const { session, svc, a } = await attestFixture(t, ['app.js', 'other.js'])
  const result = await svc.__tool.execute(attestArgs(session, {
    claims: [{ path: 'app.js', decision: 'mine' }, { path: 'other.js', decision: 'not-mine' }],
    reviewed_code_files: ['app.js'], items: [{ id: 'unit', state: 'passed' }], summary: 'Reviewed app.js.',
  }), execOf(a))
  assert.equal(result.pass, true, result.markdown)
  assert.deepEqual(result.blockers, [])
  const lines = await linesOf(svc, a)
  assert.ok(lines.includes(`- ${path.join(session, 'app.js')} (mine)`), 'the mine claim is stored')
  assert.ok(lines.includes(`- ${path.join(session, 'other.js')} (not-mine)`), 'the not-mine claim is stored')
  assert.ok(lines.includes('- unit: Unit | passed'), 'the passed item state is stored')
  assert.ok(lines.includes('Attestation: current'))
  assert.ok(lines.includes('Status: complete'))
})

test('attest refuses an unknown path, an unknown item, an unseen root, and a retired key, and changes nothing', async t => {
  const { session, svc, a } = await attestFixture(t)
  const unseen = attestRepo()
  const before = JSON.stringify(await svc.repositoryReport(a))
  const refusals = [
    [attestArgs(session, { claims: [{ path: 'missing.js', decision: 'mine' }] }), /missing\.js is not a changed file of this repository/],
    [attestArgs(session, { items: [{ id: 'nope', state: 'passed' }] }), /nope is not an item in this repository's catalog/],
    [attestArgs(unseen, { claims: [] }), /is not a repository this session has changed/],
    [attestArgs(session, { acceptance_criteria: [{ criterion: 'x', evidence: 'y' }] }), /Unknown argument: acceptance_criteria\./],
  ]
  for (const [args, expected] of refusals) {
    await assert.rejects(svc.__tool.execute(args, execOf(a)), error => {
      assert.match(error.message, expected)
      assert.match(error.message, /Nothing was changed\./)
      return true
    })
  }
  assert.equal(JSON.stringify(await svc.repositoryReport(a)), before, 'a refused attest changes no claim, item state, or attestation')
})

test('a valid but incomplete attest is stored and returns its problems', async t => {
  const { session, svc, a } = await attestFixture(t, ['app.js', 'other.js'])
  const result = await svc.__tool.execute(attestArgs(session, { claims: [{ path: 'app.js', decision: 'mine' }] }), execOf(a))
  assert.equal(result.pass, false, result.markdown)
  assert.ok(result.blockers.some(p => p.startsWith('Unclaimed changed files:') && p.includes(path.join(session, 'other.js'))), result.markdown)
  assert.ok(result.blockers.some(p => p.startsWith('Claimed code files not reviewed:') && p.includes(path.join(session, 'app.js'))), result.markdown)
  assert.ok(result.blockers.includes('Catalog item not stated: unit (Unit).'), result.markdown)
  const lines = await linesOf(svc, a)
  assert.ok(lines.includes(`- ${path.join(session, 'app.js')} (mine)`), 'the incomplete attest stored its claim')
  assert.ok(lines.includes('Attestation: current'), 'the incomplete attest is stored')
  assert.ok(lines.includes('Status: unfinished'))
})

test('a claimed code file missing from the reviewed list is a problem, and the attestation still stores', async t => {
  const { session, svc, a } = await attestFixture(t)
  const unreviewed = await svc.__tool.execute(attestArgs(session, { claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: [], items: [{ id: 'unit', state: 'passed' }] }), execOf(a))
  assert.deepEqual(unreviewed.blockers, [`Claimed code files not reviewed: ${path.join(session, 'app.js')}.`])
  assert.ok((await linesOf(svc, a)).includes('Attestation: current'), 'the attestation with the problem is stored')
  const reviewed = await svc.__tool.execute(completeAttest(session), execOf(a))
  assert.deepEqual(reviewed.blockers, [], 'reviewing the file clears the problem')
})

test('an unreadable nested repository elsewhere in the session does not block attesting a repository that reads', async t => {
  const { session, svc, a, summaries } = await attestFixture(t)
  const nested = path.join(session, 'nested')
  fs.mkdirSync(nested)
  execFileSync('git', ['init', '-q', '.'], { cwd: nested })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: nested })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: nested })
  fs.writeFileSync(path.join(nested, 'lib.js'), 'module.exports = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: nested })
  execFileSync('git', ['commit', '-qm', 'nested'], { cwd: nested })
  // The HEAD is broken before the service reads it, so no earlier HEAD stands in for the nested path.
  fs.writeFileSync(path.join(nested, '.git', 'HEAD'), 'ref: refs/heads/missing-for-test\n')
  announceTurn(svc, a, summaries, 2, session, ['nested'])
  const result = await svc.__tool.execute(completeAttest(session), execOf(a))
  assert.equal(result.pass, true, result.markdown)
  assert.deepEqual(result.blockers, [])
})

test('a refused attest changes nothing, even when a newer turn record is pending', async t => {
  const { session, svc, a, summaries } = await attestFixture(t)
  assert.equal((await svc.__tool.execute(completeAttest(session), execOf(a))).pass, true)
  fs.writeFileSync(path.join(session, 'other.js'), 'x\n')
  announceTurn(svc, a, summaries, 2, session, ['other.js'])
  const before = JSON.stringify(svc.repositories.repositories(a.id))
  const refusals = [
    [attestArgs(attestRepo(), { claims: [] }), /is not a repository this session has changed/],
    [attestArgs(session, { claims: [{ path: 'missing.js', decision: 'mine' }] }), /missing\.js is not a changed file of this repository/],
  ]
  for (const [args, expected] of refusals) {
    await assert.rejects(svc.__tool.execute(args, execOf(a)), error => {
      assert.match(error.message, expected)
      assert.match(error.message, /Nothing was changed\./)
      return true
    })
  }
  assert.equal(JSON.stringify(svc.repositories.repositories(a.id)), before, 'a refused attest changes no claim, item state, or attestation')
  const lines = await linesOf(svc, a)
  assert.ok(lines.includes(`- ${path.join(session, 'other.js')} (unclaimed)`), 'the pending turn is filed by the next read')
  assert.ok(lines.includes('Attestation: missing'), 'the next read drops the attestation, since a changed file reopens the repository')
})

test('a refused register changes no claim, item state, or attestation, even when a newer turn record is pending', async t => {
  const { session, svc, a, summaries } = await attestFixture(t)
  assert.equal((await svc.__tool.execute(completeAttest(session), execOf(a))).pass, true)
  fs.writeFileSync(path.join(session, 'other.js'), 'x\n')
  announceTurn(svc, a, summaries, 2, session, ['other.js'])
  const before = JSON.stringify(svc.repositories.repositories(a.id))
  await assert.rejects(svc.__tool.execute({ action: 'register', repository_root: attestRepo(), items: [{ name: 'Other', proves: 'other.js sets value' }] }, execOf(a)), error => {
    assert.match(error.message, /register refused/)
    assert.match(error.message, /Nothing was written\./)
    return true
  })
  assert.equal(JSON.stringify(svc.repositories.repositories(a.id)), before, 'a refused register changes no claim, item state, or attestation')
})

test('a later attest that names only items replaces the reviewed list and docs check, and keeps the claims it does not name', async t => {
  const { session, svc, a } = await attestFixture(t, ['app.js', 'other.js', 'NOTES.md'])
  const first = await svc.__tool.execute(attestArgs(session, {
    claims: [{ path: 'app.js', decision: 'mine' }, { path: 'other.js', decision: 'not-mine' }, { path: 'NOTES.md', decision: 'mine' }],
    reviewed_code_files: ['app.js'], docs_checked: true, items: [{ id: 'unit', state: 'passed' }],
  }), execOf(a))
  assert.equal(first.pass, true, first.markdown)
  const second = await svc.__tool.execute(attestArgs(session, { items: [{ id: 'unit', state: 'assumed', reason: 'x' }] }), execOf(a))
  assert.deepEqual(second.blockers, [
    `Claimed code files not reviewed: ${path.join(session, 'app.js')}.`,
    `Changed documentation not checked: ${path.join(session, 'NOTES.md')}. Check each for staleness, bloat, and conflicting information, then attest with docs_checked true.`,
  ])
  const lines = await linesOf(svc, a)
  assert.ok(lines.includes(`- ${path.join(session, 'app.js')} (mine)`), 'the earlier mine claim is kept')
  assert.ok(lines.includes(`- ${path.join(session, 'other.js')} (not-mine)`), 'the earlier not-mine claim is kept')
})

test('two attest calls that overlap on one session both keep their claims', async t => {
  const { session, svc, a } = await attestFixture(t, ['app.js', 'other.js'])
  await Promise.all([
    svc.__tool.execute(attestArgs(session, { claims: [{ path: 'app.js', decision: 'mine' }] }), execOf(a)),
    svc.__tool.execute(attestArgs(session, { claims: [{ path: 'other.js', decision: 'not-mine' }] }), execOf(a)),
  ])
  const lines = await linesOf(svc, a)
  assert.ok(lines.includes(`- ${path.join(session, 'app.js')} (mine)`), 'the claim from the first call survives the second call')
  assert.ok(lines.includes(`- ${path.join(session, 'other.js')} (not-mine)`), 'the claim from the second call is stored')
})

test('a register that overlaps an attest on one session keeps the claim the attest stored', async t => {
  const { session, svc, a } = await attestFixture(t, ['app.js', 'other.js'])
  // The register is the first call to read the report. That read stalls after the register has staged its copy, so the attest
  // runs to completion in the middle of the register, and the register's later adopt is the one that could drop the claim.
  const report = svc.repositoryReport.bind(svc)
  let stalled = false
  t.mock.method(svc, 'repositoryReport', async (agent, tracker) => {
    if (!stalled) { stalled = true; await new Promise(resolve => setTimeout(resolve, 100)) }
    return report(agent, tracker)
  })
  await Promise.all([
    svc.__tool.execute({ action: 'register', repository_root: session, items: [{ name: 'Lint', proves: 'No lint errors.' }] }, execOf(a)),
    svc.__tool.execute(attestArgs(session, { claims: [{ path: 'app.js', decision: 'mine' }] }), execOf(a)),
  ])
  const lines = await linesOf(svc, a)
  assert.ok(lines.includes(`- ${path.join(session, 'app.js')} (mine)`), 'the claim from the attest survives the overlapping register')
})

test('a changed documentation file is a problem until docs_checked is true', async t => {
  const { session, svc, a } = await attestFixture(t, ['app.js', 'README.md'])
  const readme = path.join(session, 'README.md')
  const claims = { claims: [{ path: 'app.js', decision: 'mine' }, { path: 'README.md', decision: 'mine' }], reviewed_code_files: ['app.js'], items: [{ id: 'unit', state: 'passed' }] }
  const unchecked = await svc.__tool.execute(attestArgs(session, { ...claims, docs_checked: false }), execOf(a))
  assert.ok(unchecked.blockers.some(p => p.startsWith('Changed documentation not checked:') && p.includes(readme)), unchecked.markdown)
  const checked = await svc.__tool.execute(attestArgs(session, { ...claims, docs_checked: true }), execOf(a))
  assert.deepEqual(checked.blockers, [], checked.markdown)
  assert.equal(checked.pass, true)
})

test('an assumed item without a reason is stored as unfinished and named as a problem, and a later reason clears the problem', async t => {
  const { session, svc, a } = await attestFixture(t)
  const claim = { claims: [{ path: 'app.js', decision: 'mine' }], reviewed_code_files: ['app.js'] }
  const noReason = await svc.__tool.execute(attestArgs(session, { ...claim, items: [{ id: 'unit', state: 'assumed' }] }), execOf(a))
  assert.equal(noReason.pass, false, noReason.markdown)
  assert.ok(noReason.blockers.some(p => p.startsWith('unit is marked assumed but has no reason, so it stays unfinished.')), noReason.markdown)
  const stored = await linesOf(svc, a)
  assert.ok(stored.includes(`- ${path.join(session, 'app.js')} (mine)`), 'the claim of the same call is stored')
  assert.ok(stored.includes('- unit: Unit | not stated'), 'the reasonless item is unfinished')
  assert.ok(stored.includes('Status: unfinished'))

  const passed = await svc.__tool.execute(attestArgs(session, { ...claim, items: [{ id: 'unit', state: 'passed' }] }), execOf(a))
  assert.equal(passed.pass, true, passed.markdown)
  const again = await svc.__tool.execute(attestArgs(session, { ...claim, items: [{ id: 'unit', state: 'assumed' }] }), execOf(a))
  assert.equal(again.pass, false, again.markdown)
  assert.ok((await linesOf(svc, a)).includes('- unit: Unit | not stated'), 'a reasonless assumed item clears the earlier passed state')

  const attested = await svc.__tool.execute(attestArgs(session, { ...claim, items: [{ id: 'unit', state: 'assumed', reason: 'The suite needs a database this session does not have.' }] }), execOf(a))
  assert.equal(attested.pass, true, attested.markdown)
  assert.deepEqual(attested.blockers, [])
  assert.ok((await linesOf(svc, a)).includes('- unit: Unit | assumed, not run: The suite needs a database this session does not have.'), 'the reason is kept and shown')
})

test('a rejected file leaves the problems list, and an unclaimed file keeps the gate speaking', async t => {
  const { session, svc, a } = await attestFixture(t, ['app.js', 'other.js'])
  const first = await svc.__tool.execute(completeAttest(session), execOf(a))
  assert.ok(first.blockers.some(p => p.startsWith('Unclaimed changed files:') && p.includes(path.join(session, 'other.js'))), first.markdown)
  const second = await svc.__tool.execute(attestArgs(session, { claims: [{ path: 'app.js', decision: 'mine' }, { path: 'other.js', decision: 'not-mine' }], reviewed_code_files: ['app.js'], items: [{ id: 'unit', state: 'passed' }] }), execOf(a))
  assert.deepEqual(second.blockers, [], second.markdown)
})

test('changing a recorded file after attestation reopens the repository: claims reset, items cleared, attestation dropped', async t => {
  const { session, svc, a } = await attestFixture(t)
  const attested = await svc.__tool.execute(completeAttest(session), execOf(a))
  assert.equal(attested.pass, true, attested.markdown)
  fs.writeFileSync(path.join(session, 'app.js'), 'const value = 2\n')
  const lines = await linesOf(svc, a)
  assert.ok(lines.some(line => line.startsWith('Notice: Repository ') && line.includes(`${session} changed after its attestation`)), 'the reopen is named')
  assert.ok(lines.includes(`- ${path.join(session, 'app.js')} (unclaimed)`), 'the claim is reset')
  assert.ok(lines.includes('- unit: Unit | not stated'), 'the item state is cleared')
  assert.ok(lines.includes('Attestation: missing'), 'the attestation is dropped')
})

test('a new recorded path after attestation reopens the repository', async t => {
  const { session, svc, a, summaries } = await attestFixture(t)
  const attested = await svc.__tool.execute(completeAttest(session), execOf(a))
  assert.equal(attested.pass, true, attested.markdown)
  fs.writeFileSync(path.join(session, 'new.js'), 'const added = 1\n')
  announceTurn(svc, a, summaries, 2, session, ['new.js'])
  const lines = await linesOf(svc, a)
  assert.ok(lines.some(line => line.startsWith('Notice: Repository ') && line.includes(`${session} changed after its attestation`)), 'the new path reopens the repository')
  assert.ok(lines.includes(`- ${path.join(session, 'app.js')} (unclaimed)`), 'the earlier claim is reset')
  assert.ok(lines.includes(`- ${path.join(session, 'new.js')} (unclaimed)`), 'the new path is listed unclaimed')
  assert.ok(lines.includes('Attestation: missing'))
})

test('an outer repository whose only changed file moves into a nested repository is complete, not unfinished', async t => {
  const session = attestRepo()
  const nested = path.join(session, 'pkg')
  fs.mkdirSync(nested)
  const file = path.join(nested, 'source.js')
  fs.writeFileSync(file, 'export const value = 1\n')
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  t.mock.method(svc, 'run', async () => { throw new Error('attest and status must not call run') })
  const a = agent([], { cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['pkg/source.js'])
  const attested = await svc.__tool.execute(attestArgs(session, { claims: [{ path: 'pkg/source.js', decision: 'mine' }], reviewed_code_files: ['pkg/source.js'], items: [] }), execOf(a))
  assert.equal(attested.pass, true, attested.markdown)
  execFileSync('git', ['init', '-q', '.'], { cwd: nested })
  const lines = await linesOf(svc, a)
  const outerAt = lines.indexOf(`Root: ${session}`)
  assert.ok(outerAt >= 0, 'the outer repository is listed')
  const next = lines.findIndex((line, i) => i > outerAt && line.startsWith('Root: '))
  const outer = lines.slice(outerAt, next === -1 ? lines.length : next)
  assert.ok(outer.includes('Status: complete'), `the emptied outer repository is not unfinished:\n${outer.join('\n')}`)
  assert.ok(lines.includes(`- ${file} (mine)`), 'the nested repository keeps the mine claim')
  assert.ok(lines.includes(`Notice: Repository ${session} changed after its attestation, so its claims and item states were cleared and the attestation was dropped.`), 'the reopen notice for the emptied repository states only the change, with no next step')
})

test('an emptied outer repository that still has catalog items keeps its missing attestation as a problem', async t => {
  const session = attestRepo()
  const nested = path.join(session, 'pkg')
  fs.mkdirSync(nested)
  const file = path.join(nested, 'source.js')
  fs.writeFileSync(file, 'export const value = 1\n')
  const summaries = new Map()
  const svc = statusService(summaries)
  t.after(() => cleanupService(svc))
  t.mock.method(svc, 'run', async () => { throw new Error('attest and status must not call run') })
  const a = agent([], { cwd: session })
  announceTurn(svc, a, summaries, 1, session, ['pkg/source.js'])
  await svc.__tool.execute({ action: 'register', repository_root: session, items: [{ name: 'Unit', proves: 'source.js sets value' }] }, execOf(a))
  const attested = await svc.__tool.execute(attestArgs(session, { claims: [{ path: 'pkg/source.js', decision: 'mine' }], reviewed_code_files: ['pkg/source.js'], items: [{ id: 'unit', state: 'passed' }] }), execOf(a))
  assert.equal(attested.pass, true, attested.markdown)
  execFileSync('git', ['init', '-q', '.'], { cwd: nested })
  const lines = await linesOf(svc, a)
  const outerAt = lines.indexOf(`Root: ${session}`)
  assert.ok(outerAt >= 0, 'the outer repository is listed')
  const next = lines.findIndex((line, i) => i > outerAt && line.startsWith('Root: '))
  const outer = lines.slice(outerAt, next === -1 ? lines.length : next)
  assert.ok(outer.includes('Status: unfinished'), outer.join('\n'))
  assert.ok(outer.includes('- No current attestation for this repository.'), 'the catalog item keeps the attestation obligation')
})

test('attest starts no check: a package test script that writes a marker leaves no marker behind', async t => {
  const { session, svc, a } = await attestFixture(t)
  fs.writeFileSync(path.join(session, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', scripts: { test: "node -e \"require('fs').writeFileSync('marker', '')\"" } }))
  const result = await svc.__tool.execute(completeAttest(session), execOf(a))
  assert.equal(result.pass, true, result.markdown)
  assert.equal(fs.existsSync(path.join(session, 'marker')), false, 'no check ran, so the test script did not write its marker')
})

test('the completion_gate tool takes claims, reviewed_code_files, docs_checked, and summary, and no retired argument', t => {
  const svc = statusService(new Map())
  t.after(() => cleanupService(svc))
  const properties = svc.__tool.parameters.properties
  for (const key of ['claims', 'reviewed_code_files', 'docs_checked', 'summary', 'items', 'repository_root']) assert.ok(properties[key], `the schema takes ${key}`)
  for (const key of ['acceptance_criteria', 'unresolved_issues', 'reviewed_files', 'review_summary']) assert.equal(properties[key], undefined, `the schema no longer takes ${key}`)
})
