/** Synthetic adapter contract tests; real PostgreSQL/native MCP acceptance is separate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {PersonalConsolidator} from '../src/personal-consolidation.mjs';
import {registerPersonalPlugin} from '../src/personal-plugin.mjs';
const id='11111111-1111-4111-8111-111111111111';
function fixture(rows=[]){
 const calls=[];const query=async(sql,args)=>{calls.push({sql,args});return sql.startsWith('SELECT')?rows:[];};
 const engine={kind:'postgres',executeRaw:query,transaction:async fn=>fn({executeRaw:query})};
 const ctx={engine,sourceId:'selected',remote:true,transport:'http',auth:{sourceId:'selected',scopes:['read'],principal:{kind:'oauth_client',id:'owner'}}};
 return {store:new PersonalConsolidator(ctx),calls,ctx};
}
for(const state of ['any','queued','processing','completed','failed','stale'])test('job state '+state+' is data in owner-scoped read-only SQL',async()=>{
 const f=fixture();const r=await f.store.status({state,limit:20,offset:20});assert.deepEqual(r,{source_id:'selected',jobs:[],next_offset:null});
 assert.match(f.calls[0].sql,/transaction_read_only=on/);assert.match(f.calls[1].sql,/statement_timeout='5s'/);
 const q=f.calls.at(-1);assert.match(q.sql,/source_id=\$1 AND actor_key=\$2/);assert.match(q.sql,/state=\$6/);
 assert.deepEqual(q.args,['selected',f.store.actor,null,20,20,state==='any'?null:state]);
});
for(const input of [{state:'all'},{state:"queued' OR 1=1 --"},{state:['queued']},{state:null},{state:1},
 {job_id:id,state:'queued'},{job_id:id,offset:1},{job_id:id,source_id:'other'},{actor_key:'chosen'},
 {state:'any',limit:101},{state:'any',offset:1000001},{job_id:'invalid'}])test('invalid job selector fails before any SQL '+JSON.stringify(input),async()=>{
 const f=fixture();await assert.rejects(f.store.status(input),{code:'invalid_params'});assert.equal(f.calls.length,0);
});
test('exact job read has no next page even with a limit of one',async()=>{
 const f=fixture([{id,input_id:id,input_revision:1,state:'queued',attempts:0}]);
 const r=await f.store.status({job_id:id,limit:1});assert.equal(r.jobs.length,1);assert.equal(r.next_offset,null);
});
test('unknown/hidden exact job is not a successful empty page',async()=>{
 const f=fixture();await assert.rejects(f.store.status({job_id:id}),{code:'not_found'});
});
test('live pagination returns only a valid bounded next offset',async()=>{
 const f=fixture(Array.from({length:20},()=>({state:'queued',attempts:0})));
 assert.equal((await f.store.status({limit:20,offset:40})).next_offset,60);
 assert.equal((await f.store.status({limit:20,offset:1000000})).next_offset,null);
});
test('read failures propagate and cannot manufacture an empty page',async()=>{
 const f=fixture();f.store.engine.transaction=async()=>{throw Error('synthetic unavailable');};
 await assert.rejects(f.store.status({}),/synthetic unavailable/);
});
test('native MCP status schema exposes only the canonical state selector',()=>{
 class E extends Error{}const ops=[];registerPersonalPlugin(ops,{OperationError:E});
 const op=ops.find(x=>x.name==='ultra_personal_jobs');assert.equal(op.mutating,false);assert.equal(op.scope,'read');
 assert.deepEqual(op.params.state.enum,['any','queued','processing','completed','failed','stale']);
 assert.equal(op.params.source_id,undefined);
});

test('task acceptance runs after runtime/database/browser setup and its report is uploaded afterwards',async()=>{
 const {readFileSync}=await import('node:fs');
 const workflow=readFileSync(new URL('../.github/workflows/personal-recall-preview.yml',import.meta.url),'utf8');
 const task=workflow.indexOf('run: bun test/personal-job-manager-integration.mjs');assert.ok(task>=0);
 for(const prerequisite of ['actions/setup-node@','oven-sh/setup-bun@','bash scripts/bootstrap-linux.sh',
   'playwright install --with-deps chromium','run: bun test/personal-document-module-integration.mjs']){
  assert.ok(workflow.indexOf(prerequisite)>=0&&workflow.indexOf(prerequisite)<task,prerequisite+' must precede task acceptance');
 }
 const upload=workflow.indexOf('name: personal-recall-preview-${{ github.sha }}');assert.ok(upload>task);
 for(const artifact of ['personal-job-manager-report.json','personal-job-manager.png']){
  const uploaded=workflow.slice(upload);assert.ok(uploaded.includes('${{ runner.temp }}/'+artifact),artifact+' must be uploaded after task execution');
 }
 const sourceUpload=workflow.slice(workflow.indexOf('name: document-module-source-'),workflow.indexOf('- uses: actions/setup-node@'));
 assert.ok(!sourceUpload.includes('personal-job-manager'),'Source archive must not depend on not-yet-created test outputs');
});
