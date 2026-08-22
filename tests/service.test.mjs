import test from 'node:test';import assert from 'node:assert/strict';import{CompletionGateService,turnEvidence}from'../src/index.js'
function agent(events=[],header={cwd:process.cwd()}){const steers=[];return{id:'a',session:{header,events},steer:m=>steers.push(m),steers}}
const ctx={}
test('matches screenshot-style pending action',()=>{const a=agent([{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'Now I need the call site, and in parallel start the Exa research.'}]}}},{type:'tool/call',data:{turn:1}},{type:'tool/result',data:{turn:1}}]);assert.equal(turnEvidence(a,1).futureIntent,true)})
test('does not mistake let me know for pending work',()=>{const a=agent([{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'Everything is complete. Let me know if you want changes.'}]}}}]);assert.equal(turnEvidence(a,1).futureIntent,false)})
test('reasoning-only after tools is unfinished',()=>{const a=agent([{type:'tool/call',data:{turn:2}},{type:'tool/result',data:{turn:2}},{type:'assistant/message',data:{turn:2,message:{content:[{type:'reasoning',text:'Huge finding. I should inspect next.'}]}}}]);assert.equal(turnEvidence(a,2).reasoningOnlyAfterTools,true)})
test('guard is bounded',()=>{const s=new CompletionGateService(ctx,{prematureStopMaxContinuations:2});const a=agent([{type:'assistant/message',data:{turn:3,message:{content:[{type:'text',text:'Next I will inspect the call site.'}]}}}]);assert.ok(s.premature(a,3));assert.ok(s.premature(a,3));assert.equal(s.premature(a,3),null)})
test('subagents are skipped by default',()=>{const s=new CompletionGateService(ctx,{});const a=agent([],{cwd:process.cwd(),parentSession:'parent',delegationDepth:1});assert.equal(s.applies(a),false)})
test('root agents are gated',()=>{const s=new CompletionGateService(ctx,{});assert.equal(s.applies(agent()),true)})

test('turn-stopping actually steers screenshot-style unfinished root turn',async()=>{
 const a=agent([
  {type:'assistant/message',data:{turn:11,message:{content:[{type:'text',text:'Now I need the call site to see where each value comes from, and in parallel start the Exa research you asked for.'}]}}},
  {type:'tool/call',data:{turn:11,name:'grep'}},
  {type:'tool/result',data:{turn:11}},
  {type:'assistant/message',data:{turn:11,message:{content:[{type:'reasoning',text:'HUGE finding from the Exa research.'}]}}}
 ])
 const s=new CompletionGateService(ctx,{autoDetectChecks:false,requireTests:false})
 await s.stopping({agent:a,turn:11,signal:new AbortController().signal})
 assert.equal(a.steers.length,1)
 assert.match(a.steers[0].content[0].text,/PREMATURE STOP GUARD/)
})

test('turn-stopping leaves subagent lifecycle untouched by default',async()=>{
 const a=agent([{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'Now I need to inspect next.'}]}}}],{cwd:process.cwd(),parentSession:'root',delegationDepth:1})
 const s=new CompletionGateService(ctx,{})
 await s.stopping({agent:a,turn:1,signal:new AbortController().signal})
 assert.equal(a.steers.length,0)
})
