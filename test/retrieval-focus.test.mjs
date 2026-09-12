import test from 'node:test';
import assert from 'node:assert/strict';
import {focusedEvidence,lexicalScore,queryTerms} from '../src/retrieval-focus.mjs';
import {contextTools} from '../src/context.mjs';
import {sha256} from '../src/core.mjs';
const page={source_id:'default',slug:'project/notes',title:'Notes',content:'irrelevant '.repeat(1000)+'\n最终决定：只使用本机数据库。严禁外部数据库。'};
test('query focused evidence finds Chinese facts near the end of a long document',()=>{
  const item=focusedEvidence(page,'本机数据库','L1',600);
  assert.ok(item.content.includes('严禁外部数据库'));assert.ok(item.bytes<=600);
  for(const c of item.citations)assert.equal(page.content.slice(c.start,c.end),c.quote);
  assert.equal(item.summary_method,'query-excerpt-v1');
});
test('Unicode clips and no-match excerpts are explicit',()=>{
  const p={...page,content:'🙂'.repeat(10)+'canary'+'中文'.repeat(100)};
  for(const cap of [16,64,384,512]) {
    const item=focusedEvidence(p,'canary','L0',cap);assert.ok(item.bytes<=Math.min(cap,384));assert.ok(!item.content.includes('\ufffd'));
  }
  assert.equal(focusedEvidence(p,'missing'),null);
  assert.equal(lexicalScore('nothing','database'),0);assert.ok(queryTerms('本机数据库').includes('数据'));
});
test('supplemental scan filters directory before loading content and recovers a native-cap miss',async()=>{
  const read=[];
  const store={source:'default',async call(name,p){
    if(name==='search')return [{slug:'other/top',source_id:'default'}];
    if(name==='list_pages')return [{slug:'other/a',source_id:'default'},{slug:page.slug,source_id:'default'}];
    if(name==='get_page'){read.push(p.slug);return page;}
  }};
  const r=await contextTools(store).retrieve({uri:'ultra://default/project',query:'本机数据库',scope_scan_limit:20});
  assert.ok(r.items.some(i=>i.content.includes('严禁')));assert.ok(read.every(s=>s===page.slug));
  assert.equal(r.supplemental_scan.prefix_filter_stage,'before-supplemental-content-read');
});
test('scan and content budgets are bounded and do not claim exhaustive absence',async()=>{
  let reads=0;
  const store={async call(name,p){
    if(name==='search')return [];
    if(name==='list_pages')return Array.from({length:100},(_,i)=>({slug:`project/${i}`,source_id:'default'}));
    reads++;return {...page,slug:p.slug};
  }};
  const r=await contextTools(store).retrieve({uri:'ultra://default/project',query:'absent',scope_scan_limit:100,scan_read_limit:2});
  assert.equal(reads,2);assert.equal(r.exhaustive,false);assert.equal(r.evidence_status,'no_evidence_in_searched_window');
});
test('alias redirection outside requested directory never appears as evidence',async()=>{
  const store={async call(name){if(name==='search')return [{source_id:'default',slug:'project/alias'}];return {...page,slug:'other/private'};}};
  const r=await contextTools(store).retrieve({uri:'ultra://default/project',query:'本机'});assert.deepEqual(r.items,[]);
});
test('exact source citation retrieval rejects changed content and split characters',async()=>{
  const text='first\n🙂source';const store={async call(){return {...page,content:text};}};
  const input={uri:'ultra://default/project/notes',content_sha256:sha256(text),start:6,end:text.length};
  const r=await contextTools(store).excerpt(input);assert.equal(r.content,'🙂source');
  await assert.rejects(contextTools(store).excerpt({...input,start:7}),{code:'invalid_params'});
  await assert.rejects(contextTools(store).excerpt({...input,content_sha256:'a'.repeat(64)}),{code:'stale_source'});
});
test('scan parameter and types validation fail before native operations',async()=>{
  const store={call(){assert.fail('must validate before calling');}};
  for(const extra of [{scope_scan_limit:501},{types:['bad type']},{summary:'invalid'}])
    await assert.rejects(contextTools(store).retrieve({uri:'ultra://default/project',query:'x',...extra}));
});

test('a cached general summary does not hide a query-specific original fact',async()=>{
  const store={async call(name){return name==='search'?[{source_id:'default',slug:page.slug}]:page;},
    async render(){return {content:'General project overview.',summary_status:'ready',summary_method:'grounded-map-reduce-v1'};}};
  const result=await contextTools(store).retrieve({uri:'ultra://default/project',query:'本机数据库'});
  assert.equal(result.items[0].summary_method,'query-excerpt-v1');assert.equal(result.items[0].summary_status,'bypassed_for_query');
});
