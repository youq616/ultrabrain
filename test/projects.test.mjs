import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeProject,resumeQuery,authorizeProjects,taskHash} from '../src/projects.mjs';
import {runObserved} from '../src/verify-run.mjs';
const state={goal:'Build the Linux memory service',tasks:[{id:'task1',title:'Repair CI',acceptance:['Tests pass'],status:'in_progress'}],next_actions:['Check the last test result']};
test('checkpoint normalization keeps planned and verified states distinct',()=>{
  const normal=normalizeProject(state);assert.equal(normal.tasks[0].status,'in_progress');
  assert.throws(()=>normalizeProject({...state,tasks:[{...state.tasks[0],status:'verified_complete'}]}),{code:'evidence_required'});
});
test('unknown verification assertions cannot be smuggled in checkpoint JSON',()=>{
  assert.throws(()=>normalizeProject({...state,all_tests_passed:true}),{code:'invalid_params'});
  assert.throws(()=>normalizeProject({...state,tasks:[{...state.tasks[0],verified:true}]}),{code:'invalid_params'});
});
test('task acceptance changes invalidate the execution subject hash',()=>{
  const task=normalizeProject(state).tasks[0];assert.notEqual(taskHash(task),taskHash({...task,acceptance:['New requirement']}));
});
test('continue query carries goal and unfinished task context',()=>{
  const q=resumeQuery(normalizeProject(state),'继续开发');assert.ok(q.includes(state.goal));assert.ok(q.includes('Repair CI'));
});
test('query budget is bounded even with large state',()=>{
  const q=resumeQuery(normalizeProject({...state,goal:'中'.repeat(1300)}),'继续');assert.ok(Buffer.byteLength(q)<=4096);assert.ok(!q.includes('\ufffd'));
});
test('metadata rejects delegated, directory-bound and cross-source authority',()=>{
  const base={sourceId:'default',engine:{kind:'postgres'}};
  for(const ctx of [{...base,viaSubagent:true},{...base,auth:{boundSlugPrefixes:['x/']}},{...base,auth:{sourceId:'secret'}},
    {...base,auth:{fenceProjectionDegraded:true}}]) assert.throws(()=>authorizeProjects(ctx),{code:'permission_denied'});
});
test('local verifier observes a real process, storing hashes rather than raw secrets',async()=>{
  const result=await runObserved([process.execPath,'-e',"console.log('SECRET');process.exit(0)"]);
  assert.equal(result.exit_code,0);assert.equal(result.stdout_sha256.length,64);assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('failed process is not recorded as success',async()=>{
  assert.equal((await runObserved([process.execPath,'-e','process.exit(7)'])).exit_code,7);
});
test('timeout terminates the process group and is not successful evidence',async()=>{
  const result=await runObserved([process.execPath,'-e','setInterval(()=>{},1000)'],{timeoutMs:30});
  assert.equal(result.exit_code,124);assert.equal(result.timed_out,true);
});
test('an already cancelled verification cannot execute',async()=>{
  const c=new AbortController();c.abort();await assert.rejects(runObserved([process.execPath,'-e','process.exit(0)'],{signal:c.signal}),{code:'cancelled'});
});
