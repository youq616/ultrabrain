/** Deterministic, query-focused evidence. No model calls and no inferred semantic score. */
import {clip,sha256,uri,requireThat,text} from './core.mjs';
export function queryTerms(query) {
  text(query,'query',4096);
  const words=query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu)??[];
  const terms=[];
  for(const word of words) {
    const chars=[...word];
    if(/^[\p{Script=Han}]+$/u.test(word)&&chars.length>2) {
      terms.push(word);
      for(let i=0;i<chars.length-1;i++)terms.push(chars.slice(i,i+2).join(''));
    } else if(word.length>1||/\p{Script=Han}/u.test(word))terms.push(word);
  }
  return [...new Set(terms)].sort((a,b)=>b.length-a.length).slice(0,32);
}
const escaped=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function positions(content,terms) {
  const found=[];
  for(const term of terms) {
    const pattern=new RegExp(escaped(term),'giu');let match;
    for(let n=0;n<8&&(match=pattern.exec(content));n++)found.push({start:match.index,end:match.index+match[0].length,term});
  }
  return found;
}
export function lexicalScore(content,query,title='') {
  const terms=queryTerms(query);if(!terms.length)return 0;
  const lower=content.toLowerCase(),head=title.toLowerCase();
  return terms.reduce((n,t)=>n+(lower.includes(t)?1:0)+(head.includes(t)?2:0),0)/terms.length;
}
function scalarStart(value,n) {return n>0&&n<value.length&&/[\uDC00-\uDFFF]/.test(value[n])?n-1:n;}
export function focusedEvidence(page,query,level='L1',maxBytes=3072) {
  requireThat(['L0','L1'].includes(level),'invalid_params','Focused excerpts apply to L0/L1 only');
  const source=page.content??page.compiled_truth??'';
  const hits=positions(source,queryTerms(query));if(!hits.length)return null;
  const cap=Math.min(maxBytes,level==='L0'?384:3072);
  const windows=[];
  for(const hit of hits) {
    const start=scalarStart(source,Math.max(0,hit.start-80));
    const end=scalarStart(source,Math.min(source.length,hit.end+480));
    const score=lexicalScore(source.slice(start,end),query);
    windows.push({start,end,score});
  }
  windows.sort((a,b)=>b.score-a.score||a.start-b.start);
  const selected=[];let used=0;
  for(const w of windows) {
    if(selected.some(s=>w.start<s.end&&w.end>s.start))continue;
    const available=cap-used-(selected.length?2:0);if(available<=0)break;
    const value=clip(source.slice(w.start,w.end),available);
    if(!value)break;
    selected.push({...w,end:w.start+value.length,quote:value});used+=Buffer.byteLength(value)+(selected.length>1?2:0);
    if(selected.length>=3||used>=cap)break;
  }
  selected.sort((a,b)=>a.start-b.start);
  const content=selected.map(s=>s.quote).join('\n\n');
  const hash=sha256(source);
  return {uri:uri(page.source_id,page.slug),level,content,bytes:Buffer.byteLength(content),
    content_sha256:hash,updated_at:page.updated_at,truncated:content!==source,summary_method:'query-excerpt-v1',
    model_calls:0,trust:'untrusted-memory-data',
    citations:selected.map((s,i)=>({id:`excerpt${i+1}`,uri:uri(page.source_id,page.slug),content_sha256:hash,
      quote:s.quote,start:s.start,end:s.end,start_line:source.slice(0,s.start).split('\n').length,
      end_line:source.slice(0,s.end).split('\n').length,offset_unit:'UTF-16 code units'})),
    evidence_assurance:'Exact authorized source excerpts, not a generated summary or answer'};
}
