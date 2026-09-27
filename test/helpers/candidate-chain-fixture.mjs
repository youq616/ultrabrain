/** Explicit synthetic GitHub transport; never an independent review or live API. */
import {evidence as one,receipt} from './candidate-fixture.mjs';
export const shas=['a','b','c','d','e','f','1','2','3'].map(c=>c.repeat(40));
export function chainSelection(n=2){return {format:'ultrabrain-candidate-chain-selection-v1',repository:'youq616/ultrabrain',
 anchor_sha:shas[0],tip_sha:shas[n],reviewer_ids:[2,3],candidates:Array.from({length:n},(_,i)=>({pr:29+i,base_sha:shas[i],head_sha:shas[i+1]}))};}
export function chainTransport(n=2){
 const selection=chainSelection(n),data=selection.candidates.map((p,i)=>{
  const e=one();e.pull.number=p.pr;e.pull.head.sha=p.head_sha;e.pull.base.sha=p.base_sha;e.commit.sha=p.head_sha;
  e.commit.tree.sha=(i+4).toString(16).repeat(40);
  e.runs.forEach((r,k)=>{r.id=(i+1)*100+k;r.head_sha=p.head_sha;r.pull_requests=[{number:p.pr,head:{sha:p.head_sha},base:{sha:p.base_sha}}];});
  e.jobs=Object.fromEntries(e.runs.map(r=>[r.id,[{id:r.id+1000,run_id:r.id,run_attempt:1,status:'completed',conclusion:'success'}]]));
  e.reviews[0].body=receipt({...p,head_sha:p.head_sha,base_sha:p.base_sha});e.reviews[0].commit_id=p.head_sha;
  return e;
 });
 const calls=[],counts=new Map();
 const get=async path=>{
  calls.push(path);counts.set(path,(counts.get(path)??0)+1);
  const u=new URL('https://api.github.com'+path),pathname=u.pathname,page=Number(u.searchParams.get('page')??1);
  const base='/repos/youq616/ultrabrain';
  if(pathname.startsWith(base+'/compare/')){
   const [a,b]=pathname.slice((base+'/compare/').length).split('...');
   return {base_commit:{sha:a},merge_base_commit:{sha:a},status:'ahead',ahead_by:1,behind_by:0,total_commits:1,commits:[]};
  }
  if(pathname===base+'/git/commits/'+selection.anchor_sha)return {sha:selection.anchor_sha,tree:{sha:'0'.repeat(40)}};
  const e=data.find(e=>pathname===base+'/pulls/'+e.pull.number||pathname===base+'/pulls/'+e.pull.number+'/reviews'||
   pathname===base+'/git/commits/'+e.commit.sha||u.searchParams.get('head_sha')===e.commit.sha||
   Object.hasOwn(e.jobs,/\/runs\/(\d+)\//.exec(pathname)?.[1]??''));
  if(!e)throw Error('Unexpected synthetic route '+path);
  if(pathname.endsWith('/reviews'))return structuredClone(e.reviews.slice((page-1)*100,page*100));
  if(pathname===base+'/pulls/'+e.pull.number)return structuredClone(e.pull);
  if(pathname.includes('/git/commits/'))return structuredClone(e.commit);
  if(pathname.endsWith('/actions/runs'))return {total_count:e.runs.length,workflow_runs:structuredClone(e.runs.slice((page-1)*100,page*100))};
  const m=/\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(pathname);
  if(m){const list=e.jobs[m[1]];return {total_count:list.length,jobs:structuredClone(list.slice((page-1)*100,page*100))};}
  throw Error('Unexpected synthetic route '+path);
 };
 return {selection,data,calls,counts,get};
}
