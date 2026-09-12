import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {observeWorkspace,workspaceEvidence,matchesCodeRevision,codeRevision} from '../src/workspace-evidence.mjs';
import {runObserved} from '../src/verify-run.mjs';
import {normalizeProject,taskHash} from '../src/projects.mjs';
import {sha256} from '../src/core.mjs';
function repository(t) {
  const cwd=mkdtempSync(join(tmpdir(),'ub-workspace-'));
  t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(join(cwd,'code.txt'),'version one\n');writeFileSync(join(cwd,'.gitignore'),'ignored-output\n');
  git('add','.');git('commit','-qm','fixture');
  return {cwd,git,commit:git('rev-parse','HEAD')};
}
test('revision validation and legacy task hashes stay backward compatible',()=>{
  const task={id:'test',title:'Run tests',acceptance:['Pass'],status:'in_progress'};
  assert.equal(taskHash(task),sha256(JSON.stringify([task.id,task.title,task.acceptance])));
  const bound={...task,code_revision:'a'.repeat(40)};
  assert.notEqual(taskHash(task),taskHash(bound));
  assert.notEqual(taskHash(bound),taskHash({...bound,code_revision:'b'.repeat(40)}));
  assert.equal(normalizeProject({goal:'Ship',tasks:[bound]}).tasks[0].code_revision,bound.code_revision);
  assert.equal(codeRevision('a'.repeat(64)),'a'.repeat(64));
  for(const value of [null,'HEAD','deadbeef','A'.repeat(40),'a'.repeat(41)])assert.throws(()=>codeRevision(value),{code:'invalid_params'});
});
test('successful process binds to clean Git observations without paths or stdout',async t=>{
  const {cwd,commit}=repository(t);
  const r=await runObserved([process.execPath,'-e','console.log("sensitive output")'],{cwd});
  assert.equal(r.exit_code,0);assert.equal(r.workspace.stable,true);
  assert.equal(matchesCodeRevision(r.workspace,commit),true);
  assert.equal(matchesCodeRevision(r.workspace,'b'.repeat(40)),false);
  assert.ok(!JSON.stringify(r).includes(cwd));assert.ok(!JSON.stringify(r).includes('sensitive output'));
});
for(const kind of ['modified','staged','untracked'])test(`${kind} content cannot qualify a clean revision`,async t=>{
  const {cwd,commit,git}=repository(t);
  writeFileSync(join(cwd,kind==='untracked'?'private-filename':'code.txt'),'secret content');
  if(kind==='staged')git('add','code.txt');
  const r=await runObserved([process.execPath,'-e','0'],{cwd});
  assert.equal(r.workspace.before.clean,false);assert.equal(matchesCodeRevision(r.workspace,commit),false);
  assert.ok(!JSON.stringify(r.workspace).includes('private-filename'));
});
test('changes left by the command invalidate the final observation',async t=>{
  const {cwd,commit}=repository(t);
  const r=await runObserved([process.execPath,'-e',"require('fs').writeFileSync('code.txt','changed')"],{cwd});
  assert.equal(r.workspace.before.clean,true);assert.equal(r.workspace.after.clean,false);
  assert.equal(matchesCodeRevision(r.workspace,commit),false);
});
test('different HEAD after the command fails even when both worktrees are clean',async t=>{
  const {cwd,commit}=repository(t);
  const r=await runObserved(['git','commit','--allow-empty','-qm','different revision'],{cwd});
  assert.equal(r.workspace.before.clean,true);assert.equal(r.workspace.after.clean,true);
  assert.notEqual(r.workspace.after.commit,commit);assert.equal(matchesCodeRevision(r.workspace,commit),false);
});
test('non-Git execution still records exit status but cannot verify a revision',async t=>{
  const cwd=mkdtempSync(join(tmpdir(),'ub-no-git-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  const r=await runObserved([process.execPath,'-e','0'],{cwd});
  assert.equal(r.exit_code,0);assert.equal(r.workspace.before.available,false);
  assert.equal(matchesCodeRevision(r.workspace,'a'.repeat(40)),false);
});
test('ambient Git redirection cannot substitute another checkout',async t=>{
  const original=repository(t),other=repository(t);
  writeFileSync(join(original.cwd,'code.txt'),'dirty original');
  const previous=process.env.GIT_WORK_TREE;
  process.env.GIT_WORK_TREE=other.cwd;
  try {assert.equal((await observeWorkspace(original.cwd)).clean,false);}
  finally {if(previous===undefined)delete process.env.GIT_WORK_TREE;else process.env.GIT_WORK_TREE=previous;}
});
test('ignored files are an explicit observation limit, not a build attestation',async t=>{
  const {cwd,commit}=repository(t);writeFileSync(join(cwd,'ignored-output'),'unattested');
  const b=await observeWorkspace(cwd),w=workspaceEvidence(b,b);
  assert.equal(matchesCodeRevision(w,commit),true);assert.ok(w.scope.includes('ignored files'));
});
test('legacy, malformed and inconsistent evidence fails closed for a bound task',()=>{
  const b={available:true,clean:true,commit:'a'.repeat(40),root_sha256:'b'.repeat(64)};
  for(const w of [null,{},workspaceEvidence(b,{...b,root_sha256:'c'.repeat(64)}),
    {format:1,stable:true,before:{...b,clean:false},after:b}])assert.equal(matchesCodeRevision(w,b.commit),false);
});
for(const flag of ['--assume-unchanged','--skip-worktree'])test(`${flag} cannot conceal modified code`,async t=>{
  const {cwd,commit,git}=repository(t);
  git('update-index',flag,'code.txt');writeFileSync(join(cwd,'code.txt'),'hidden change');
  const r=await runObserved([process.execPath,'-e','0'],{cwd});
  assert.equal(r.workspace.before.index_flags_clear,false);
  assert.equal(matchesCodeRevision(r.workspace,commit),false);
});
