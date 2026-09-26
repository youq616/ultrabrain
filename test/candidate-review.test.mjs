/** Separate implementation-assistant review probes; not a second-agent review. */
import test from 'node:test';import assert from 'node:assert/strict';
import {evaluateCandidate} from '../src/candidate-check.mjs';
import {collectCandidate} from '../src/candidate-github.mjs';
import {candidateMain} from '../scripts/candidate-check.mjs';
import {selection,evidence,transport,head,base} from './helpers/candidate-fixture.mjs';
test('review: a rerun of an older same-head run cannot hide behind a newer successful run ID',async()=>{
  const t=transport();t.data.runs.push({...t.data.runs[0],id:99,run_attempt:2,status:'completed',conclusion:'failure'});
  t.data.jobs[99]=[{id:999,run_id:99,run_attempt:2,status:'completed',conclusion:'failure'}];
  const r=await collectCandidate(selection(),t);assert.equal(r.status,'blocked');assert.notEqual(r.ci[0].state,'passed');
  assert.ok(t.calls.some(path=>path.includes('/runs/99/attempts/2/jobs')));
});
test('review: head and base must come from the same PR association',()=>{
  const e=evidence();e.runs[0].pull_requests=[{number:29,head:{sha:head},base:{sha:'d'.repeat(40)}},
    {number:29,head:{sha:'e'.repeat(40)},base:{sha:base}}];
  const r=evaluateCandidate(selection(),e);assert.notEqual(r.ci[0].state,'passed');
});
test('review: cancellation after collection but before stdout withholds a successful report',async()=>{
  const controller=new AbortController();let out='';
  const code=await candidateMain(['--pr','29','--head',head,'--base',base],{signal:controller.signal,write:s=>out+=s,
    collect:async()=>{controller.abort();return {status:'metadata_requirements_met',merge_authorized:false};}});
  assert.equal(code,1);assert.equal(JSON.parse(out).error,'aborted');assert.equal(JSON.parse(out).status,undefined);
});
test('review: submission time, not draft-creation ID, determines the last decisive review',()=>{
  const e=evidence();e.reviews[0].id=20;
  e.reviews.push({...e.reviews[0],id:10,state:'CHANGES_REQUESTED',submitted_at:'2026-09-26T10:30:00Z'});
  const r=evaluateCandidate(selection(),e);assert.equal(r.status,'blocked');assert.ok(r.blockers.includes('review_changes_requested'));
});
