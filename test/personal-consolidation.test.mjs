import test from 'node:test';
import assert from 'node:assert/strict';
import {captureRequest,personalModelProfile,parsePersonalCandidates,generatePersonalCandidates} from '../src/personal-consolidation-core.mjs';
import {personalWorkerOptions,personalWorkerSummary} from '../src/personal-worker.mjs';
const input={agent_id:'codex',event_id:'stable-1',consent:true,transcript:'用户：不要使用 Docker Hub。'};
const sample={type:'preference',content:'用户要求不要使用 Docker Hub。',quote:'不要使用 Docker Hub'};
const profile=personalModelProfile({enabled:true,model:'fixture:model',revision:'test',timeout_ms:1000});
test('personal input retains an explicit immutable event, consent and project',()=>{
  assert.equal(captureRequest(input).transcript,input.transcript);assert.equal(captureRequest(input).project_id,null);
  for(const extra of [{consent:false},{consent:'true'},{source_id:'other'},{actor_key:'fake'},{visibility:'source'},{event_id:'../../x'},{transcript:'a'.repeat(32769)},{transcript:'\ud800'}])assert.throws(()=>captureRequest({...input,...extra}));
});
test('personal model permission is separate, disabled or missing means no profile',()=>{
  assert.equal(personalModelProfile(undefined),null);assert.equal(personalModelProfile({enabled:false}),null);
  for(const p of [{enabled:true,model:'https://api.invalid',revision:'x'},{enabled:true,model:'ok:model'},{...profile,endpoint:'arbitrary'},{enabled:true,model:'ok:model',revision:'x',timeout_ms:120001}])assert.throws(()=>personalModelProfile(p));
});
test('typed candidates require exact evidence, remain private and do not invent scores',()=>{
  const rows=parsePersonalCandidates(JSON.stringify({memories:[sample]}),input.transcript);
  assert.equal(rows[0].visibility,'private');assert.equal(rows[0].confidence,null);assert.equal(rows[0].importance,'normal');
  assert.equal(input.transcript.slice(rows[0].evidence.start,rows[0].evidence.end),sample.quote);
});
test('empty extraction is legitimate; repeated exact entries are collapsed only within a batch',()=>{
  assert.deepEqual(parsePersonalCandidates('{"memories":[]}',input.transcript),[]);
  assert.equal(parsePersonalCandidates(JSON.stringify({memories:[sample,sample]}),input.transcript).length,1);
});
for(const sampleOutput of [{memories:[{...sample,quote:'not in source'}]},{memories:[{...sample,type:'system'}]},{memories:[{...sample,confidence:1}]},{memories:[{...sample,status:'active'}]},{memories:[{...sample,visibility:'source'}]},{memories:[sample],command:'run this'},{memories:Array(17).fill(sample)},{memories:[{...sample,content:'x'.repeat(2049)}]}])
 test('reject model authority expansion or ungrounded output '+JSON.stringify(sampleOutput).slice(0,130),()=>assert.throws(()=>parsePersonalCandidates(JSON.stringify(sampleOutput),input.transcript),{code:'invalid_personal_output'}));
test('invalid JSON, fences and overlong model output fail closed',()=>{
  for(const raw of ['```json\n{}\n```','not-json','x'.repeat(32769),null])assert.throws(()=>parsePersonalCandidates(raw,input.transcript),{code:'invalid_personal_output'});
});
test('generation supplies untrusted data, no tools, retains negation and real usage counters only',async()=>{
  const r=await generatePersonalCandidates(input.transcript,profile,async request=>{
    assert.equal(JSON.parse(request.prompt).untrusted_transcript,input.transcript);assert.equal(request.tools,undefined);
    return {text:JSON.stringify({memories:[sample]}),stopReason:'end',usage:{input_tokens:100,output_tokens:25}};
  });
  assert.equal(r.memories[0].content,sample.content);assert.equal(r.usage.input_tokens,100);
});
test('pre-aborted input sends no provider request',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(generatePersonalCandidates(input.transcript,profile,async()=>calls++,{signal:controller.signal}),{code:'personal_model_timeout'});assert.equal(calls,0);
});
test('provider deadline is bounded even when the provider ignores cancellation',async()=>{
  await assert.rejects(generatePersonalCandidates(input.transcript,profile,()=>new Promise(()=>{})),{code:'personal_model_timeout'});
});
test('truncated provider output is not accepted as complete extraction',async()=>{
  await assert.rejects(generatePersonalCandidates(input.transcript,profile,async()=>({text:'{"memories":[]}',stopReason:'length'})),{code:'invalid_personal_output'});
});
test('worker requires exactly one identity mode and explicit model permission',()=>{
  const args=['--local','--source','default','--allow-model-call'];assert.equal(personalWorkerOptions(args).loop,false);
  for(const bad of [args.slice(0,-1),[...args,'--url','https://server/mcp'],[...args,'--token-file','/secret'],[...args,'--loop','--retry'],[...args,'--limit','5'],[...args,'--local']])assert.throws(()=>personalWorkerOptions(bad));
  assert.equal(personalWorkerOptions(['--url','https://server/mcp','--token-file','/secret','--source','default','--allow-model-call']).local,false);
});
test('worker report has counts only, not excerpts or result objects',()=>{
  const r=personalWorkerSummary({source_id:'default',results:[{state:'completed',result:{content:'PRIVATE'}}],model_requests_attempted:1},'default');
  assert.equal(r.states.completed,1);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
  assert.throws(()=>personalWorkerSummary({source_id:'other',results:[]},'default'));
});
