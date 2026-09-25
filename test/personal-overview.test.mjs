/** Contract and production SQL adapter. Synthetic DB responses; real SQL requires the separate integration fixture. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewRequest,verifyPersonalOverview} from '../src/personal-overview-contract.mjs';
import {PersonalOverview} from '../src/personal-overview.mjs';
import {registerPersonalPlugin} from '../src/personal-plugin.mjs';
const id='11111111-1111-4111-8111-111111111111';
export function data(){return {format:'ultrabrain-personal-overview-v1',scope:'owned-all-projects',source_id:'selected',request_id:id,
 observed_at:'2026-09-22T12:00:00.000Z',read_only:true,model_calls:0,trust:'untrusted-memory-metadata',
 memories:{total:12,candidate:5,active:4,archived:3,active_current:3,active_stale:1,candidate_stale:2,document_fragments:2},
 jobs:{total:15,queued:2,processing:4,completed:3,failed:5,stale:1,processing_live:1,processing_expired:3,failed_below_attempt_limit:2},
 documents:{total:3,active:2,archived:1},agents:{total:2}};}
function fixture(){
 const calls=[],value=data();let onRead=()=>{};
 const executeRaw=async(sql,args)=>{calls.push({sql,args});if(sql.trimStart().startsWith('WITH ')){await onRead();const {observed_at,memories,jobs,documents,agents}=value;return [{observed_at,memories,jobs,documents,agents}];}return [];};
 const engine={kind:'postgres',executeRaw,transaction:async f=>f({executeRaw})};
 const ctx={engine,sourceId:'selected',remote:true,transport:'http',auth:{sourceId:'selected',scopes:['read'],principal:{kind:'oauth_client',id:'owner'}}};
 return {calls,value,ctx,store:new PersonalOverview(ctx),onRead:fn=>onRead=fn};
}
test('overview: exact request frozen, no caller source/project selectors',()=>{
 const input={request_id:id};const r=overviewRequest(input);assert.deepEqual(r,input);assert.notEqual(r,input);assert.ok(Object.isFrozen(r));
});
for(const input of [undefined,null,[],{},'x',{request_id:id.toUpperCase().replace('1','A')},{request_id:'bad'},
 {request_id:id,source_id:'other'},{request_id:id,actor_key:'foreign'},{request_id:id,project_id:'x'},
 {request_id:id,consent:true},{request_id:id,limit:20}])test('overview: invalid selector rejected '+JSON.stringify(input),()=>{
 assert.throws(()=>overviewRequest(input),{code:'invalid_params'});
});
test('overview: complete validated response is a frozen owned copy',()=>{
 const raw=data(),r=verifyPersonalOverview(raw,{request_id:id},'selected');assert.deepEqual(r,raw);assert.notEqual(r,raw);
 assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.memories));assert.ok(!Object.isFrozen(raw));raw.memories.total=999;assert.equal(r.memories.total,12);
});
for(const [name,change]of [
 ['foreign source',r=>r.source_id='other'],['old request',r=>r.request_id='22222222-2222-4222-8222-222222222222'],
 ['false write',r=>r.read_only=false],['model call',r=>r.model_calls=1],['extra text',r=>r.content='PRIVATE'],
 ['foreign scope',r=>r.scope='source-wide'],['fake trust',r=>r.trust='trusted'],['bad format',r=>r.format='other'],
 ['invalid date',r=>r.observed_at='2026-02-30T12:00:00.000Z'],['local date',r=>r.observed_at='2026-09-22T12:00:00+09:00'],
 ['memory partition',r=>r.memories.total++],['active partition',r=>r.memories.active_current++],
 ['candidate subset',r=>r.memories.candidate_stale=6],['fragment subset',r=>r.memories.document_fragments=13],
 ['job partition',r=>r.jobs.total++],['lease partition',r=>r.jobs.processing_live++],['failed subset',r=>r.jobs.failed_below_attempt_limit=6],
 ['document partition',r=>r.documents.active++],['missing agents',r=>delete r.agents],['empty agents',r=>r.agents={}],
 ['extra label',r=>r.agents.name='PRIVATE'],['string count',r=>r.agents.total='2'],['fraction',r=>r.agents.total=0.5],
 ['overflow',r=>r.agents.total=2147483648],['infinity',r=>r.agents.total=Infinity],['negative',r=>r.agents.total=-1],
 ['missing field',r=>delete r.jobs.stale]
])test('overview: entire inconsistent result withheld: '+name,()=>{
 const r=data();change(r);assert.throws(()=>verifyPersonalOverview(r,{request_id:id},'selected'),{code:'personal_overview_unconfirmed'});
});
test('overview: empty library is valid but distinct from unread/error state',()=>{
 const r=data();for(const group of ['memories','jobs','documents','agents'])for(const key of Object.keys(r[group]))r[group][key]=0;
 assert.equal(verifyPersonalOverview(r,{request_id:id},'selected').memories.total,0);
});
test('overview: one read-only owner-scoped statement, bounded by local timeouts',async()=>{
 const f=fixture();assert.deepEqual(await f.store.read({request_id:id}),data());
 assert.deepEqual(f.calls.slice(0,3).map(c=>c.sql),['SET LOCAL transaction_read_only=on',"SET LOCAL statement_timeout='5s'","SET LOCAL lock_timeout='1s'"]);
 assert.equal(f.calls.length,4);const {sql,args}=f.calls[3];assert.deepEqual(args,['selected',f.store.actor]);
 assert.equal((sql.match(/source_id=\$1 AND actor_key=\$2/g)??[]).length,4);
 assert.match(sql,/statement_timestamp\(\)/);assert.match(sql,/lease_until<=/);assert.match(sql,/origin.actor_key=m.actor_key/);
 assert.ok(!/SELECT\s+\*|FOR UPDATE|advisory|\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(sql));
});
test('overview: invalid input never executes SQL',async()=>{const f=fixture();await assert.rejects(f.store.read({request_id:id,source_id:'other'}));assert.equal(f.calls.length,0);});
test('overview: storage failure never becomes a successful zero count',async()=>{
 const f=fixture();f.ctx.engine.transaction=async()=>{throw Error('private database path');};await assert.rejects(f.store.read({request_id:id}));
});
test('overview: invalid aggregate is rejected before any response',async()=>{
 const f=fixture();f.value.jobs.total=0;await assert.rejects(f.store.read({request_id:id}),{code:'personal_overview_unconfirmed'});
});
for(const change of ['actor','source','scope','federation','bound','engine'])test('overview: authority change during DB read refuses delivery: '+change,async()=>{
 const f=fixture();f.onRead(()=>{
  if(change==='actor')f.ctx.auth.principal.id='other';else if(change==='source')f.ctx.sourceId='other';
  else if(change==='scope')f.ctx.auth.scopes=[];else if(change==='federation')f.ctx.localFederatedSourceIds=['selected','other'];
  else if(change==='bound')f.ctx.auth.boundSlugPrefixes=['private'];else f.ctx.engine={kind:'postgres'};
 });await assert.rejects(f.store.read({request_id:id}),{code:'permission_denied'});
});
test('overview: constructor enforces existing authentication/grant boundary',()=>{
 const f=fixture();f.ctx.auth.hasSourceGrant=false;assert.throws(()=>new PersonalOverview(f.ctx),{code:'permission_denied'});
});
test('overview: native compatibility MCP registers a read tool with no model dependency',async()=>{
 const ops=[];class E extends Error{constructor(code,message){super(message);this.code=code;}}
 registerPersonalPlugin(ops,{OperationError:E},()=>{assert.fail('No model configuration read');});
 const op=ops.find(o=>o.name==='ultra_personal_overview');assert.ok(op);assert.equal(op.scope,'read');assert.equal(op.mutating,false);
 assert.deepEqual(Object.keys(op.params),['request_id']);const f=fixture();assert.deepEqual(await op.handler(f.ctx,{request_id:id}),data());
 f.ctx.engine.transaction=async()=>{throw Error('PRIVATE_DB_ERROR');};await assert.rejects(op.handler(f.ctx,{request_id:id}),e=>e.code==='personal_storage_error'&&!e.message.includes('PRIVATE_DB_ERROR'));
});

// Keep every previously accepted cross-platform file, exactly once, plus the new read-only module suites.
test('overview: additive CI wiring preserves all baseline suites, setup and artifact order',async()=>{
 const {readFileSync}=await import('node:fs');
 const portable=readFileSync(new URL('../.github/workflows/client-portability.yml',import.meta.url),'utf8');
 const names=portable.split('\n').find(l=>l.includes('run: node --test ')).split('node --test ')[1].trim().split(/\s+/);
 const baseline=["test/client-snapshot-trace.test.mjs", "test/client-snapshot-trace-cli.test.mjs", "test/client-snapshot-audit.test.mjs", "test/client-snapshot-audit-cli.test.mjs", "test/snapshot-offline-guard.test.mjs", "test/client-snapshot.test.mjs", "test/client-snapshot-files.test.mjs", "test/client-snapshot-races.test.mjs", "test/client-snapshot-cli.test.mjs", "test/client-snapshot-package.test.mjs", "test/client-lineage.test.mjs", "test/client-lineage-runtime.test.mjs", "test/client-lineage-cli.test.mjs", "test/personal-lineage.test.mjs", "test/personal-lineage-ui.test.mjs", "test/personal-snapshot-explorer.test.mjs", "test/personal-snapshot-explorer-ui.test.mjs", "test/personal-snapshot-inspector.test.mjs", "test/personal-snapshot-inspector-ui.test.mjs", "test/personal-snapshot.test.mjs", "test/personal-snapshot-browser.test.mjs", "test/personal-job-recovery-barrier.test.mjs", "test/personal-job-recovery.test.mjs", "test/personal-document-module.test.mjs", "test/personal-document-read.test.mjs", "test/personal-jobs.test.mjs", "test/personal-job-manager.test.mjs", "test/personal-document-receipts.test.mjs", "test/personal-console-receipts.test.mjs", "test/personal-memory-compare.test.mjs", "test/personal-memory-read.test.mjs", "test/personal-memory-lookup.test.mjs", "test/client-authorization.test.mjs", "test/client-profile-authorization.test.mjs", "test/client-request-authorization.test.mjs", "test/client-task-context.test.mjs", "test/client-kit.test.mjs", "test/personal-documents.test.mjs", "test/client-document-boundaries.test.mjs", "test/native-adapters.test.mjs", "test/capture-outbox.test.mjs", "test/automatic-capture.test.mjs", "test/capture-hardening.test.mjs", "test/capture-delivery.test.mjs", "test/capture-profile-binding.test.mjs", "test/client-release-docs.test.mjs", "test/client-snapshot-impact.test.mjs", "test/client-snapshot-impact-boundaries.test.mjs", "test/client-snapshot-impact-cli.test.mjs", "test/client-snapshot-navigation.test.mjs"];
 // The repaired 50-suite prefix is immutable; overview must be appended.
 assert.deepEqual(names.slice(0,baseline.length),baseline);
 assert.deepEqual(names.slice(baseline.length),['test/personal-overview.test.mjs','test/personal-overview-ui.test.mjs','test/personal-overview-http.test.mjs','test/personal-overview-boundaries.test.mjs']);
 assert.equal(names.length,new Set(names).size);assert.ok(portable.includes('windows-2025')&&portable.includes('ubuntu-24.04'));
 const preview=readFileSync(new URL('../.github/workflows/personal-recall-preview.yml',import.meta.url),'utf8');
 const step=preview.indexOf('run: bun test/personal-overview-integration.mjs');assert.ok(step>0);
 for(const prerequisite of ['bash scripts/bootstrap-linux.sh','playwright install --with-deps chromium','run: bun test/personal-lineage-integration.mjs'])assert.ok(preview.indexOf(prerequisite)<step);
 const upload=preview.indexOf('name: personal-recall-preview-${{ github.sha }}');assert.ok(upload>step);
 assert.ok(preview.slice(upload).includes('personal-overview-report.json')&&preview.slice(upload).includes('personal-overview.png'));
});
