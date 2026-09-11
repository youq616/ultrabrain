import test from 'node:test';
import assert from 'node:assert/strict';
import { contextTools } from '../src/context.mjs';
function mock() {
  const pages = Array.from({length:230}, (_,i) => ({source_id:'default',slug:`resources/${i}`,title:`Title ${i}`,content:`Note ${i}`,compiled_truth:`Note ${i}`}));
  const calls = [];
  return {source:'default',calls,pages, async call(name,p) {
    calls.push([name,p]);
    if (p.source_id && p.source_id !== 'default') throw Object.assign(new Error('denied'),{code:'scope_denied'});
    if (name === 'list_pages') return pages.slice(p.offset,p.offset+p.limit);
    if (name === 'search') return pages.slice(0,p.limit);
    if (name === 'get_page') { const r=pages.find(x=>x.slug===p.slug); if (!r) throw Object.assign(new Error('missing'),{code:'page_not_found'}); return r; }
    if (name === 'put_page') return {slug:p.slug};
    if (name === 'delete_page') return {deleted:true};
    throw new Error('unexpected operation');
  }};
}
test('read is delegated to native current ACL checks', async () => {
  const store=mock(), tools=contextTools(store);
  await assert.rejects(tools.read({uri:'ultra://secret/resources/0'}),{code:'scope_denied'});
  assert.equal((await tools.read({uri:'ultra://default/resources/0',level:'L2'})).content,'Note 0');
  assert.equal(store.calls.at(-1)[1].include_content,true);
});
test('write source cannot be supplied by an arbitrary URI', async () => {
  const store=mock(); await assert.rejects(contextTools(store).write({uri:'ultra://secret/a',content:'x'}),{code:'scope_denied'});
  assert.equal(store.calls.length,0);
});
test('write is full replacement through native put_page', async () => {
  const store=mock(); await contextTools(store).write({uri:'ultra://default/a',content:'---\ntype: note\n---\nText'});
  assert.equal(store.calls[0][0],'put_page'); assert.equal(store.calls[0][1].content,'---\ntype: note\n---\nText');
});
test('directory scan reports caps rather than claiming completeness', async () => {
  const r=await contextTools(mock()).list({uri:'ultra://default/',scan_limit:120});
  assert.equal(r.scanned,120); assert.equal(r.complete_scan,false); assert.equal(r.next_offset,120);
  assert.equal(r.entries[0].kind,'directory');
});
test('directory iteration reaches final source-page window', async () => {
  const r=await contextTools(mock()).list({uri:'ultra://default/',offset:200,scan_limit:100});
  assert.equal(r.scanned,30); assert.equal(r.complete_scan,true); assert.equal(r.next_offset,null);
});
test('entry cap does not skip unprocessed rows in a fetched batch', async () => {
  const r=await contextTools(mock()).list({uri:'ultra://default/resources',limit:3});
  assert.equal(r.scanned,3); assert.equal(r.next_offset,3);
});
test('native response drift fails loudly', async () => {
  const store={source:'default',async call(){return {pages:[]};}};
  await assert.rejects(contextTools(store).list({uri:'ultra://default/'}),{code:'upstream_contract_changed'});
});
test('retrieve returns evidence and trace with honest candidate limits', async () => {
  const r=await contextTools(mock()).retrieve({uri:'ultra://default/resources',query:'note',limit:4,budget_bytes:1500});
  assert.ok(r.evidence_bytes <= 1500); assert.equal(r.exhaustive,false); assert.ok(r.trace.length>0);
  assert.equal(r.prefix_filter_stage,'after-native-candidate-retrieval');
});
test('deletion uses native soft-delete operation', async () => {
  const store=mock(); await contextTools(store).remove({uri:'ultra://default/resources/0'});
  assert.equal(store.calls[0][0],'delete_page');
});
