/** Read-only, one-shot GitHub metadata collector. Fixed repository and GET paths.
 * Does not follow server URLs, redirects, artifact downloads or retry requests. */
import {candidateSelection,evaluateCandidate,requireCandidate,CandidateError,CANDIDATE_WORKFLOWS,positive} from './candidate-check.mjs';
import {assertClientAuthorized} from './client-authorization.mjs';
const ROOT='/repos/youq616/ultrabrain';
const LIMIT=4*1024*1024;
const MAX_PAGES=10;
const jsonCopy=v=>JSON.parse(JSON.stringify(v)); // Only decoded JSON from trusted transport seam.
export function candidateReader({token,signal,fetchImpl=globalThis.fetch}={}){
  requireCandidate(token===undefined||typeof token==='string'&&/^[!-~]{1,4096}$/.test(token),'invalid_params');
  return async path=>{
    requireCandidate(typeof path==='string'&&path.startsWith(ROOT+'/')&&!/[\\#\x00-\x20]/.test(path)&&!path.includes('..'),'invalid_params');
    // Constrain even the injected get seam to the exact read-only API families.
    requireCandidate(new RegExp('^'+ROOT+'/(?:pulls/[1-9][0-9]*(?:/reviews)?|git/commits/[a-f0-9]{40}|actions/runs(?:/[1-9][0-9]*/attempts/[1-9][0-9]*/jobs)?)(?:\\?[a-z0-9_=&]+)?$').test(path),'invalid_params');
    const active=AbortSignal.any([signal,AbortSignal.timeout(10000)].filter(Boolean));
    let response,reader;
    try{
      response=await fetchImpl('https://api.github.com'+path,{method:'GET',redirect:'error',signal:active,
        headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(token?{Authorization:'Bearer '+token}:{})}});
      if(response.status===429||response.status===403&&(response.headers.get('x-ratelimit-remaining')==='0'||response.headers.has('retry-after')))throw new CandidateError('candidate_rate_limited');
      requireCandidate(response.status===200,'candidate_http_failed');
      const length=response.headers.get('content-length');
      requireCandidate(length===null||/^\d+$/.test(length)&&Number(length)<=LIMIT,'candidate_response_too_large');
      requireCandidate(response.body,'candidate_contract_invalid');reader=response.body.getReader();
      let size=0;const chunks=[];
      while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
        requireCandidate(size<=LIMIT,'candidate_response_too_large');chunks.push(Buffer.from(part.value));}
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    }catch(e){
      if(signal?.aborted)throw new CandidateError('aborted');
      if(active.aborted)throw new CandidateError('candidate_timeout');
      if(e instanceof CandidateError)throw e;throw new CandidateError('candidate_http_failed');
    }finally{
      if(reader){try{await reader.cancel();}catch{}reader.releaseLock();}
      else if(response?.body)try{await response.body.cancel();}catch{}
    }
  };
}
export async function collectCandidate(input,{get,token,signal,authorize=()=>{}}={}){
  const p=candidateSelection(input),active=AbortSignal.any([signal,AbortSignal.timeout(90000)].filter(Boolean));
  const allowed=()=>assertClientAuthorized(authorize,active);
  const read=get??candidateReader({token,signal:active});let requests=0;
  const call=async path=>{allowed();requireCandidate(++requests<=80,'candidate_pagination_incomplete');
    const data=await read(ROOT+path);allowed();return data;};
  const list=async(path,key)=>{
    const result=[],ids=new Set();let total;
    for(let page=1;page<=MAX_PAGES;page++){
      const response=await call(path+(path.includes('?')?'&':'?')+'per_page=100&page='+page);
      const rows=key?response[key]:response;
      requireCandidate(Array.isArray(rows)&&rows.length<=100);
      if(key){requireCandidate(Number.isSafeInteger(response.total_count)&&response.total_count>=0);
        if(total===undefined)total=response.total_count;
        requireCandidate(total===response.total_count&&total<=1000,'candidate_pagination_incomplete');}
      for(const r of rows){requireCandidate(positive(r.id)&&!ids.has(r.id),'candidate_pagination_incomplete');ids.add(r.id);result.push(r);}
      if(rows.length<100||key&&result.length===total){
        requireCandidate(!key||result.length===total,'candidate_pagination_incomplete');return result;
      }
    }
    throw new CandidateError('candidate_pagination_incomplete');
  };
  const pullPath='/pulls/'+p.pr,runPath='/actions/runs?event=pull_request&head_sha='+p.head_sha;
  const pull=await call(pullPath);
  const binding=r=>({number:r.number,head:r.head?.sha,base:r.base?.sha,repo:r.base?.repo?.full_name,
    head_repo:r.head?.repo?.full_name,repo_id:r.base?.repo?.id,head_repo_id:r.head?.repo?.id,author:r.user?.id,state:r.state,draft:r.draft,merged:r.merged});
  const bound=binding(pull);
  requireCandidate(bound.number===p.pr&&bound.head===p.head_sha&&bound.base===p.base_sha&&bound.repo===p.repository&&bound.head_repo===p.repository,'candidate_changed');
  const commit=await call('/git/commits/'+p.head_sha);
  const runs=await list(runPath,'workflow_runs'),reviews=await list(pullPath+'/reviews'),jobs={};
  // Read each current-base run, including reruns of lower IDs. Never borrow a
  // base from a different PR association or silently drop an older failing run.
  for(const r of runs)if(CANDIDATE_WORKFLOWS.some(f=>r.path==='.github/workflows/'+f)&&r.event==='pull_request'&&r.head_sha===p.head_sha&&
    r.repository?.id===bound.repo_id&&r.head_repository?.id===bound.head_repo_id&&
    r.pull_requests?.some(pr=>pr.number===p.pr&&pr.head?.sha===p.head_sha&&pr.base?.sha===p.base_sha)){
      requireCandidate(positive(r.run_attempt));
      jobs[r.id]=await list('/actions/runs/'+r.id+'/attempts/'+r.run_attempt+'/jobs','jobs');
    }
  // Reobserve collections: superseding runs/attempts, dismissed/edited reviews or
  // changed head/base/draft fail closed. This detects observed races, not an API transaction.
  const lastRuns=await list(runPath,'workflow_runs'),lastReviews=await list(pullPath+'/reviews');
  const stamp=r=>({id:r.id,path:r.path,event:r.event,head:r.head_sha,attempt:r.run_attempt,status:r.status,conclusion:r.conclusion,
    repository:r.repository?.id,head_repository:r.head_repository?.id,pulls:r.pull_requests});
  const ordered=(rows,project)=>rows.map(project).sort((a,b)=>a.id-b.id);
  const reviewStamp=r=>({id:r.id,user:r.user?.id,state:r.state,commit_id:r.commit_id,body:r.body,submitted_at:r.submitted_at});
  requireCandidate(JSON.stringify(ordered(runs,stamp))===JSON.stringify(ordered(lastRuns,stamp))&&
    JSON.stringify(ordered(reviews,reviewStamp))===JSON.stringify(ordered(lastReviews,reviewStamp)),'candidate_changed');
  requireCandidate(JSON.stringify(binding(await call(pullPath)))===JSON.stringify(bound),'candidate_changed');
  const report=evaluateCandidate(p,jsonCopy({pull,commit,runs,reviews,jobs}));allowed();
  return Object.freeze({...report,observed_at:new Date().toISOString(),github_get_requests:requests,evidence_source:get?'caller-supplied-transport':'github-rest-api'});
}
