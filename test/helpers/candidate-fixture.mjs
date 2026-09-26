import {CANDIDATE_WORKFLOWS} from '../../src/candidate-check.mjs';
export const head='a'.repeat(40),base='b'.repeat(40);
export const selection=()=>({repository:'youq616/ultrabrain',pr:29,head_sha:head,base_sha:base,reviewer_ids:[2,3]});
export const receipt=(patch={})=>JSON.stringify({format:'ultrabrain-independent-review-v1',repository:'youq616/ultrabrain',
  pr:29,head_sha:head,base_sha:base,scope:'entire-diff',reviewer_session:'SYNTHETIC-SESSION-not-an-actual-review',independent:true,
  verdict:'approve',findings:[],tests:[{command:'node --test synthetic.test.mjs',exit_code:0,passed:1,failed:0,skipped:0}],...patch});
export function evidence(){
  const repo={id:10,full_name:'youq616/ultrabrain'};
  const pull={number:29,state:'open',merged:false,draft:false,user:{id:1},head:{sha:head,repo},base:{sha:base,repo}};
  const runs=CANDIDATE_WORKFLOWS.map((file,i)=>({id:100+i,path:'.github/workflows/'+file,event:'pull_request',head_sha:head,
    repository:repo,head_repository:repo,run_attempt:1,status:'completed',conclusion:'success',
    pull_requests:[{number:29,head:{sha:head},base:{sha:base}}]}));
  return {pull,commit:{sha:head,tree:{sha:'c'.repeat(40)}},runs,
    reviews:[{id:1,state:'APPROVED',user:{id:2},commit_id:head,body:receipt(),submitted_at:'2026-09-26T10:00:00Z'}],
    jobs:Object.fromEntries(runs.map(r=>[r.id,[{id:r.id+100,run_id:r.id,run_attempt:1,status:'completed',conclusion:'success'}]]))};
}
export function transport(data=evidence()){
  const calls=[];const counts=new Map();
  const get=async path=>{
    calls.push(path);counts.set(path,(counts.get(path)??0)+1);
    const u=new URL('https://api.github.com'+path),p=u.pathname;const page=Number(u.searchParams.get('page')??1);
    if(p.endsWith('/reviews'))return structuredClone(data.reviews.slice((page-1)*100,page*100));
    if(p.endsWith('/pulls/29'))return structuredClone(data.pull);
    if(p.includes('/git/commits/'))return structuredClone(data.commit);
    if(p.endsWith('/actions/runs'))return {total_count:data.runs.length,workflow_runs:structuredClone(data.runs.slice((page-1)*100,page*100))};
    const m=/\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(p);
    if(m){const list=data.jobs[m[1]]??[];return {total_count:list.length,jobs:structuredClone(list.slice((page-1)*100,page*100))};}
    throw Error('Unexpected synthetic GET '+p);
  };
  return {get,calls,counts,data};
}
