import test from 'node:test';
import assert from 'node:assert/strict';
import {summaryProfile,splitDocument,mapClaims,reduceClaims,generateSummary,validateDocument,profileHash} from '../src/semantic-core.mjs';
import {sha256} from '../src/core.mjs';
const profile=summaryProfile({enabled:true,model:'fixture:controlled',revision:'test',chunk_bytes:1024,max_chunks:16,timeout_ms:1000});
function generator() {
  const prompts=[];
  const generate=async p=>{
    const parsed=JSON.parse(p.prompt);prompts.push(parsed);
    if(parsed.segment) {
      const quote=parsed.segment.text.slice(-120);
      return {text:JSON.stringify({claims:[{text:quote,quote}]}),model:'fixture:controlled',stopReason:'end'};
    }
    const last=parsed.claims.at(-1);
    return {text:JSON.stringify({abstract:{text:'A source-grounded summary.',evidence_ids:[last.id]},overview:[{text:last.text,evidence_ids:[last.id]}]}),model:'fixture:controlled',stopReason:'end'};
  };
  return {generate,prompts};
}
test('profiles are disabled by default and require explicit provider model and revision',()=>{
  assert.equal(summaryProfile(),null);assert.equal(summaryProfile({enabled:false}),null);
  for(const raw of [{enabled:true},{enabled:true,model:'https://secret@host',revision:'1'},
    {enabled:true,model:'fixture:model',revision:'1',chunk_bytes:1}])assert.throws(()=>summaryProfile(raw));
  assert.notEqual(profileHash(profile),profileHash({...profile,revision:'2'}));
});
test('Unicode chunk partition covers the ENTIRE input with correct offsets',()=>{
  const text='中文🙂'.repeat(1200),chunks=splitDocument(text,profile);
  assert.equal(chunks.map(c=>c.text).join(''),text);
  for(const c of chunks){assert.equal(text.slice(c.start,c.end),c.text);assert.ok(Buffer.byteLength(c.text)<=1024);assert.ok(!c.text.includes('\ufffd'));}
});
test('input overflow is rejected before any model call',async()=>{
  let count=0;
  await assert.rejects(generateSummary('a'.repeat(20000),profile,async()=>count++),{code:'summary_input_too_large'});
  assert.equal(count,0);
});
test('late document facts reach the reduction step, not merely a prefix',async()=>{
  const text='background '.repeat(250)+'\nFinal decision: do not expose PostgreSQL externally.';
  const {generate,prompts}=generator();const result=await generateSummary(text,profile,generate);
  assert.ok(result.overview[0].text.includes('do not expose PostgreSQL'));
  assert.ok(prompts.length>2);assert.equal(prompts.at(-1).claims.at(-1).quote.endsWith('externally.'),true);
  assert.equal(result.coverage.input_bytes,Buffer.byteLength(text));assert.equal(result.content_sha256,sha256(text));
  validateDocument(result,text);
});
test('fabricated, out-of-segment and malformed source citations are rejected',()=>{
  const text='first\nsecond';const segments=splitDocument(text,profile);
  for(const raw of ['```json\n{}\n```','{"claims":[{"text":"x","quote":"invented"}]}',
    '{"claims":[{"text":"x","quote":"first","execute":"shell"}]}'])assert.throws(()=>mapClaims(raw,segments[0],text));
  assert.throws(()=>mapClaims('{"claims":[{"text":"x","quote":"first"}]}',{id:'c2',text:'second',start:6,end:12},text));
});
test('reducer cannot cite unknown ids or omit evidence',()=>{
  const claims=[{id:'c1.f1',text:'fact',quote:'fact'}];
  for(const evidence_ids of [[],['invented'],['c1.f1','c1.f1']])assert.throws(()=>reduceClaims(JSON.stringify({abstract:{text:'abstract',evidence_ids},overview:[{text:'overview',evidence_ids:['c1.f1']}]}),claims));
});
test('cached output with tampered original, quotes or line locations is rejected',async()=>{
  const text='line one\nline two',document=await generateSummary(text,profile,generator().generate);
  assert.throws(()=>validateDocument(document,text+'changed'),{code:'stale_summary'});
  const changed=structuredClone(document);changed.evidence[0].start_line+=1;
  assert.throws(()=>validateDocument(changed,text),{code:'invalid_summary'});
  changed.evidence[0].start_line-=1;changed.evidence[0].quote='forged';
  assert.throws(()=>validateDocument(changed,text),{code:'invalid_summary'});
});
test('model refusal, truncation and no-evidence responses cannot become completed summaries',async()=>{
  await assert.rejects(generateSummary('source',profile,async()=>({text:'{}',stopReason:'length'})),{code:'invalid_summary'});
  await assert.rejects(generateSummary('source',profile,async()=>({text:'{"claims":[]}'})),{code:'summary_no_evidence'});
});
test('pre-cancellation avoids model calls and hanging providers meet an overall deadline',async()=>{
  const c=new AbortController();c.abort();let count=0;
  await assert.rejects(generateSummary('source',profile,async()=>count++,{signal:c.signal}),{code:'summary_timeout'});
  assert.equal(count,0);
  await assert.rejects(generateSummary('source',{...profile,timeout_ms:20},()=>new Promise(()=>{})),{code:'summary_timeout'});
});
test('raw credentials or provider metadata are not persisted in call receipts',async()=>{
  const original=generator().generate;
  const d=await generateSummary('source',profile,async p=>({...await original(p),model:'https://user:SECRET@host',providerMetadata:{key:'SECRET'}}));
  assert.ok(!JSON.stringify(d).includes('SECRET'));assert.equal(d.model_calls[0].model,null);
});
