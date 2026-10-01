import test from 'node:test';
import assert from 'node:assert/strict';
import {agentIdentity,contextRequest,memoryCommit} from '../src/agent-memory-protocol.mjs';
import {registerAgent,contextRequest as oldContext,commitRequest} from '../src/agent-protocol.mjs';
import {normalizePersonalMemory,classifyMemory} from '../src/personal-memory.mjs';
import {buildPersonalContext} from '../src/personal-context-engine.mjs';
import {registerPersonalPlugin,PERSONAL_TOOL_NAMES} from '../src/personal-plugin.mjs';

test('draft protocol paths share the exact canonical implementation',()=>{
  assert.strictEqual(registerAgent,agentIdentity);assert.strictEqual(contextRequest,oldContext);assert.strictEqual(commitRequest,memoryCommit);
});
test('client metadata never accepts a self-assigned trust flag or owner',()=>{
  const p={agent_id:'claude-code',agent_type:'coding_agent',capabilities:['code','code']};
  assert.deepEqual(agentIdentity(p).capabilities,['code']);
  for(const field of ['source_id','owner_key','actor_key','trust_level','verified'])assert.throws(()=>agentIdentity({...p,[field]:'fake'}));
});
test('identifiers and agent metadata have bounded strict shapes',()=>{
  for(const agent_id of ['bad id','x'.repeat(97),null,4])assert.throws(()=>agentIdentity({agent_id}));
  for(const capabilities of ['code',[null],[{}],Array(33).fill('a')])assert.throws(()=>agentIdentity({agent_id:'codex',capabilities}));
});
test('commit needs consent and stable event id; no invented clock or confidence',()=>{
  const p={agent_id:'codex',event_id:'turn1',consent:true,summary:'Explicitly submitted experience'};
  const result=memoryCommit(p);assert.equal(result.memories[0].confidence,null);assert.equal(result.memories[0].type,'experience');
  for(const consent of [false,undefined,'true'])assert.throws(()=>memoryCommit({...p,consent}),{code:'capture_disabled'});
  assert.throws(()=>memoryCommit({...p,event_id:undefined}));assert.throws(()=>memoryCommit({...p,memories:[]}));
});
test('summary and list are explicit alternatives; empty/oversized commits rejected',()=>{
  const p={agent_id:'codex',event_id:'turn1',consent:true};
  for(const memories of [[],null,Array(17).fill({type:'skill',content:'a'})])assert.throws(()=>memoryCommit({...p,memories}));
  assert.throws(()=>memoryCommit({...p,memories:Array(5).fill({type:'skill',content:'x'.repeat(65536)})}));
});
test('classification is only a hint and never returns a trust probability',()=>{
  assert.equal(classifyMemory('用户喜欢命令行'),'preference');assert.equal(classifyMemory('运行 Ubuntu'),'environment');
  assert.equal(typeof classifyMemory('Unclassified experience'),'string');
});
test('context excludes candidate/archived and wrong-project data, independent of confidence',()=>{
  const rows=[{id:'a',type:'preference',content:'Use CLI',confidence:null,importance:'high',status:'active',project_id:null},
    {id:'b',type:'error',content:'unreviewed',confidence:1,importance:'high',status:'candidate'},
    {id:'c',type:'skill',content:'wrong project',confidence:1,importance:'high',status:'active',project_id:'other'}];
  const context=buildPersonalContext(rows,{task:'CLI',project_id:'mine'});
  assert.deepEqual(context.memories.map(x=>x.id),['a']);assert.equal(context.trust,'untrusted-memory-data');
});
test('context never truncates individual instructions to satisfy its serialized budget',()=>{
  const rows=[{id:'a',type:'preference',content:'x'.repeat(5000)+' DO NOT SHARE',importance:'high',status:'active'},
    {id:'b',type:'preference',content:'Do not use Docker Hub',importance:'normal',status:'active'}];
  const out=buildPersonalContext(rows,{budget_bytes:700});
  assert.ok(Buffer.byteLength(JSON.stringify(out))<=700);assert.equal(out.memories[0].id,'b');assert.equal(out.dropped,1);
});
test('personal tools have real handlers and consistent read/write scopes',()=>{
  class E extends Error{constructor(code,msg){super(msg);this.code=code;}}
  const operations=[];assert.equal(registerPersonalPlugin(operations,{OperationError:E}).length,20); // Previous 19 plus the scoped metadata-only candidate list
  assert.deepEqual(operations.map(x=>x.name),PERSONAL_TOOL_NAMES);
  const previous=["ultra_personal_capture", "ultra_personal_consolidate", "ultra_personal_jobs", "ultra_personal_cancel", "ultra_agent_register", "ultra_agent_list", "ultra_memory_commit", "ultra_memory_read", "ultra_memory_search", "ultra_personal_context", "ultra_memory_profile", "ultra_personal_review", "ultra_personal_update", "ultra_personal_document_import", "ultra_personal_document_list", "ultra_personal_document_read", "ultra_personal_document_queue", "ultra_personal_document_archive"];
  assert.deepEqual([...operations.map(x=>x.name)].sort(),[...previous,'ultra_personal_overview','ultra_personal_candidates'].sort());
  const overview=operations.find(x=>x.name==='ultra_personal_overview');assert.equal(overview.scope,'read');assert.equal(overview.mutating,false);
  assert.ok(operations.every(x=>typeof x.handler==='function'&&x.mutating===(x.scope==='write')));
  assert.throws(()=>registerPersonalPlugin(operations,{OperationError:E}),{code:'upstream_contract_changed'});
});

test('search time bounds preserve UTC microseconds and existing query defaults',async()=>{
  const {searchQuery,contextQuery}=await import('../src/personal-memory.mjs');
  assert.deepEqual(searchQuery(),{...contextQuery(),updated_from:null,updated_before:null});
  for(const fraction of ['', '.1','.12','.123','.1234','.12345','.123456']){
    const input='2024-02-29T23:59:59'+fraction+'Z';
    const expected='2024-02-29T23:59:59.'+fraction.slice(1).padEnd(6,'0')+'Z';
    assert.equal(searchQuery({updated_from:input}).updated_from,expected);
    assert.equal(searchQuery({updated_before:input}).updated_before,expected);
  }
  for(const value of ['0001-01-01T00:00:00Z','9999-12-31T23:59:59.999999Z','2000-02-29T00:00:00Z'])
    assert.ok(searchQuery({updated_from:value}).updated_from);
  const input={query:'literal',task:'task',agent_id:'one',project_id:'two',types:['goal','goal'],status:'candidate',limit:3,offset:2,budget_bytes:2048};
  const result=searchQuery({...input,updated_from:'2024-01-01T00:00:00.000001Z',updated_before:'2024-01-01T00:00:00.000002Z'});
  const {updated_from,updated_before,...rest}=result;
  assert.deepEqual(rest,contextQuery(input));assert.ok(Object.isFrozen(result));assert.ok(updated_from<updated_before);
});
test('search time grammar, Gregorian dates, range and input shape are strict',async()=>{
  const {searchQuery,contextQuery}=await import('../src/personal-memory.mjs');
  const invalid=[1,true,[],{}, '2024-01-01','2024-01-01T00:00:00+00:00','2024-01-01t00:00:00z',
    ' 2024-01-01T00:00:00Z','2024-01-01T00:00:00Z\n','2024-01-01T00:00:00.Z','2024-01-01T00:00:00.0000001Z',
    '2024-01-01T00:00:00.1234560Z','0000-01-01T00:00:00Z','10000-01-01T00:00:00Z','2024-00-01T00:00:00Z',
    '2024-13-01T00:00:00Z','2024-01-00T00:00:00Z','2024-01-32T00:00:00Z','2024-04-31T00:00:00Z',
    '1900-02-29T00:00:00Z','2023-02-29T00:00:00Z','2024-02-30T00:00:00Z','2024-01-01T24:00:00Z',
    '2024-01-01T00:60:00Z','2024-01-01T00:00:60Z','infinity',"2024-01-01T00:00:00Z' OR true --"];
  for(const field of ['updated_from','updated_before']){
    for(const value of invalid)assert.throws(()=>searchQuery({[field]:value}),{code:'invalid_params'},`${field}: ${JSON.stringify(value)}`);
    for(const value of ['2024-01-01T00:00:00Z',null,''])assert.throws(()=>contextQuery({[field]:value}),{code:'invalid_params'});
  }
  for(const input of [null,[],[{}],1,'query',true])assert.throws(()=>searchQuery(input),{code:'invalid_params'});
  for(const [from,before] of [['.1','.100000'],['.000002','.000001'],['','']])
    assert.throws(()=>searchQuery({updated_from:'2024-01-01T00:00:00'+from+'Z',updated_before:'2024-01-01T00:00:00'+before+'Z'}),{code:'invalid_params'});
  assert.throws(()=>searchQuery({unknown:true}),{code:'invalid_params'});
});
test('only memory search advertises optional updated-time fields',()=>{
  const operations=[];registerPersonalPlugin(operations,{OperationError:Error});
  for(const operation of operations){
    for(const field of ['updated_from','updated_before']){
      if(operation.name==='ultra_memory_search'){
        assert.equal(operation.params[field].type,'string');assert.equal(operation.params[field].required,false);
      }else assert.ok(!Object.hasOwn(operation.params,field));
    }
  }
});


test('search preserves inherited and non-enumerable existing query fields',async()=>{
  const {searchQuery,contextQuery}=await import('../src/personal-memory.mjs');
  const fields={query:'literal',task:'task',agent_id:'one',project_id:'two',types:['goal'],status:'archived',limit:3,offset:2,budget_bytes:2048};
  const inputs=[Object.create(fields),Object.defineProperties({},Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,{value}])) )];
  for(const input of inputs){
    assert.deepEqual(searchQuery(input),{...contextQuery(input),updated_from:null,updated_before:null});
    Object.defineProperty(input,'updated_from',{value:'2024-01-01T00:00:00.000001Z'});
    assert.deepEqual(searchQuery(input),{...contextQuery(input),updated_from:'2024-01-01T00:00:00.000001Z',updated_before:null});
    input.unknown=true;assert.throws(()=>searchQuery(input),{code:'invalid_params'});
  }
});


test('new search bounds consistently treat null and exact empty strings as absence',async()=>{
  const {searchQuery}=await import('../src/personal-memory.mjs');
  const stamp='2024-02-29T12:00:00.000001Z';
  for(const field of ['updated_from','updated_before'])for(const absent of [undefined,null,'']){
    assert.deepEqual(searchQuery({[field]:absent}),searchQuery(),`${field}: ${JSON.stringify(absent)} equals omitted`);
    const other=field==='updated_from'?'updated_before':'updated_from';
    assert.deepEqual(searchQuery({[field]:absent,[other]:stamp}),searchQuery({[other]:stamp}),`${field}: absence keeps ${other}`);
  }
  assert.deepEqual(searchQuery({updated_from:null,updated_before:''}),searchQuery());
  for(const field of ['updated_from','updated_before'])for(const value of [' ','\t','\n',false,0,[],{}])
    assert.throws(()=>searchQuery({[field]:value}),{code:'invalid_params'},`${field}: ${JSON.stringify(value)} is not absence`);
});
