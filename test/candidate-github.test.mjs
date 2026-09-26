import test from 'node:test';import assert from 'node:assert/strict';
import {candidateReader,collectCandidate} from '../src/candidate-github.mjs';
import {evidence,selection,transport} from './helpers/candidate-fixture.mjs';
test('collector: exact GET families, fixed nine workflows, stable snapshot',async()=>{
  const t=transport(),r=await collectCandidate(selection(),t);assert.equal(r.status,'metadata_requirements_met');
  assert.equal(r.github_get_requests,16);assert.ok(t.calls.every(p=>p.startsWith('/repos/youq616/ultrabrain/')));
  assert.ok(t.calls.some(p=>p.includes('/attempts/1/jobs')));assert.equal(r.evidence_source,'caller-supplied-transport');
});
test('collector: paginates reviews and jobs without accepting first-page evidence',async()=>{
  const t=transport();t.data.reviews=Array.from({length:105},(_,i)=>({...t.data.reviews[0],id:i+1,state:i===104?'CHANGES_REQUESTED':'COMMENTED'}));
  t.data.jobs[100]=Array.from({length:105},(_,i)=>({...t.data.jobs[100][0],id:200+i,conclusion:i===104?'failure':'success'}));
  const r=await collectCandidate(selection(),t);assert.equal(r.ci[0].jobs,105);assert.equal(r.ci[0].state,'failed_or_incomplete');
  assert.ok(r.blockers.includes('review_changes_requested'));assert.ok(t.calls.some(p=>p.endsWith('page=2')));
});
for(const kind of ['duplicate','inflated','truncated','over-limit'])test('collector: incomplete pagination fails closed '+kind,async()=>{
  const t=transport();const get=async p=>{const r=await t.get(p);if(p.includes('/actions/runs?')){
    if(kind==='duplicate'){r.workflow_runs.push(r.workflow_runs[0]);r.total_count++;}
    else if(kind==='inflated')r.total_count++;else if(kind==='truncated')r.total_count--;else r.total_count=1001;
  }return r;};
  await assert.rejects(collectCandidate(selection(),{get}),{code:'candidate_pagination_incomplete'});
});
for(const field of ['head','base','draft','state'])test('collector: PR '+field+' changes during collection',async()=>{
  const t=transport();let n=0;const get=async p=>{const r=await t.get(p);if(p.endsWith('/pulls/29')&&++n===2){
    if(field==='head'||field==='base')r[field].sha='d'.repeat(40);else r[field]=field==='draft'?true:'closed';}return r;};
  await assert.rejects(collectCandidate(selection(),{get}),{code:'candidate_changed'});
});
for(const kind of ['attempt','new-run','review-dismissal','review-body'])test('collector: evidence race '+kind+' aborts whole observation',async()=>{
  const t=transport();let runs=0,reviews=0;const get=async p=>{const r=await t.get(p);
    if(p.includes('/actions/runs?')&&++runs===2){if(kind==='attempt')r.workflow_runs[0].run_attempt++;
      if(kind==='new-run'){r.workflow_runs.push({...r.workflow_runs[0],id:999});r.total_count++;}}
    if(p.includes('/reviews?')&&++reviews===2){if(kind==='review-dismissal')r[0].state='DISMISSED';if(kind==='review-body')r[0].body='edited';}
    return r;};await assert.rejects(collectCandidate(selection(),{get}),{code:'candidate_changed'});
});
test('collector: pre-abort and false authorization perform no reads',async()=>{
  const t=transport(),c=new AbortController();c.abort();await assert.rejects(collectCandidate(selection(),{...t,signal:c.signal}),{code:'aborted'});
  await assert.rejects(collectCandidate(selection(),{...t,authorize:()=>false}),{code:'client_authorization_revoked'});assert.equal(t.calls.length,0);
});
test('collector: input pins/reviewers snapshot before first await',async()=>{
  const t=transport(),p=selection();let first=true;const get=async path=>{if(first){first=false;p.head_sha='d'.repeat(40);p.reviewer_ids.length=0;}return t.get(path);};
  const r=await collectCandidate(p,{get});assert.equal(r.status,'metadata_requirements_met');assert.equal(r.reviews.configured_reviewer_ids.length,2);
});
test('reader: HTTPS fixed host, GET, no redirects, token only in header',async()=>{
  let seen;const read=candidateReader({token:'SYNTHETIC_TOKEN',fetchImpl:async(url,options)=>{seen={url,options};return new Response('{}');}});
  await read('/repos/youq616/ultrabrain/pulls/29');assert.equal(seen.url,'https://api.github.com/repos/youq616/ultrabrain/pulls/29');
  assert.equal(seen.options.method,'GET');assert.equal(seen.options.redirect,'error');assert.ok(!seen.url.includes('TOKEN'));
  assert.equal(seen.options.headers.Authorization,'Bearer SYNTHETIC_TOKEN');
});
for(const path of ['https://evil.test','/repos/other/repo/pulls/1','/repos/youq616/ultrabrain/../secrets',
  '/repos/youq616/ultrabrain/actions/runs/1/rerun','/repos/youq616/ultrabrain/pulls/29/merge','/repos/youq616/ultrabrain/pulls/29#evil'])
  test('reader: forbidden route rejected before credentials '+path,async()=>{
    let n=0;const read=candidateReader({fetchImpl:async()=>{n++;return new Response('{}');}});
    await assert.rejects(read(path),{code:'invalid_params'});assert.equal(n,0);
  });
for(const status of [301,302,401,403,404,429,500])test('reader: HTTP '+status+' safely rejected',async()=>{
  const read=candidateReader({fetchImpl:async()=>new Response('PRIVATE_BODY',{status})});
  await assert.rejects(read('/repos/youq616/ultrabrain/pulls/29'),e=>!e.message.includes('PRIVATE'));
});
for(const mode of ['header','stream','json','utf8'])test('reader: bounded response refusal '+mode,async()=>{
  const read=candidateReader({fetchImpl:async()=>mode==='header'?new Response('{}',{headers:{'content-length':'9999999'}}):
    mode==='stream'?new Response('x'.repeat(4*1024*1024+1)):mode==='json'?new Response('PRIVATE_BROKEN'):
      new Response(new Uint8Array([0xff]))});
  await assert.rejects(read('/repos/youq616/ultrabrain/pulls/29'));
});
test('reader: cancellation at response read remains aborted, not private diagnostics',async()=>{
  const c=new AbortController();const read=candidateReader({signal:c.signal,fetchImpl:async()=>{c.abort();throw Error('PRIVATE_TOKEN');}});
  await assert.rejects(read('/repos/youq616/ultrabrain/pulls/29'),{code:'aborted'});
});
