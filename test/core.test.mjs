import test from 'node:test';
import assert from 'node:assert/strict';
import { uri, parseUri, clip, layers, pack, within, rankHierarchy, integer, text } from '../src/core.mjs';
const page = { source_id: 'default', slug: 'resources/中文', title: '标题',
  compiled_truth: '中文🙂'.repeat(2000), content: '---\ntype: note\n---\n' + '中文🙂'.repeat(2000) };
test('canonical Unicode URI round trip', () => {
  assert.deepEqual(parseUri(uri('default','resources/你好 world')), {
    source: 'default', slug: 'resources/你好 world', uri: 'ultra://default/resources/%E4%BD%A0%E5%A5%BD%20world' });
});
test('NFC normalization is deterministic', () => assert.equal(uri('default','cafe\u0301'), uri('default','café')));
test('root URI is valid', () => assert.equal(parseUri('ultra://default/').slug, ''));
for (const unsafe of [
  'ultra://default/a/../b', 'ultra://default/%2e%2e/b', 'ultra://default/%252e%252e/b',
  'ultra://default/a%2Fb', 'ultra://default/a%5cb', 'ultra://default/%00', 'ultra://default/%ZZ',
  'ultra://default/a?source=secret', 'ultra://default/a#x', 'ultra://default//a',
  'ultra://default/a/', 'ultra://Default/a', 'http://default/a', 'ultra://x@y/a',
]) test(`reject unsafe URI ${unsafe}`, () => assert.throws(() => parseUri(unsafe)));
test('scope prefixes have directory boundaries', () => {
  assert.equal(within('team-secret/a','team'), false); assert.equal(within('team/a','team'), true);
});
test('Unicode clipping never creates replacement characters or exceeds byte budget', () => {
  for (let n = 0; n < 40; n++) {
    const s = clip('中文🙂'.repeat(10), n);
    assert.ok(Buffer.byteLength(s) <= n); assert.ok(!s.includes('\ufffd'));
  }
});
test('L0 and L1 are bounded and explicitly extractive', () => {
  for (const [level, max] of [['L0',384],['L1',3072]]) {
    const result = layers(page,level);
    assert.ok(result.bytes <= max); assert.equal(result.summary_method,'extractive-prefix-v1');
    assert.equal(result.truncated,true);
  }
});
test('L2 round-trips canonical frontmatter and content', () => assert.equal(layers(page,'L2').content,page.content));
test('unknown layer fails', () => assert.throws(() => layers(page,'L3')));
test('hash changes on canonical edits', () => assert.notEqual(layers(page).content_sha256,
  layers({...page, content: page.content+'x'}).content_sha256));
test('evidence budget includes metadata and JSON overhead', () => {
  const items = Array.from({length: 10}, (_,i) => ({uri: uri('default',`${i}`),content:'中文'.repeat(i+1)}));
  const result = pack(items,128);
  assert.ok(Buffer.byteLength(JSON.stringify(result.items)) <= 128);
  assert.equal(result.dropped,10-result.items.length);
});
test('directory rerank filters prefixes and deduplicates pages', () => {
  const r = rankHierarchy([
    {source_id:'default',slug:'private/a'}, {source_id:'default',slug:'r/a'},
    {source_id:'default',slug:'r/a'}, {source_id:'default',slug:'r/sub/b'}], 'r',10);
  assert.equal(r.length,2); assert.ok(r.every(h => within(h.slug,'r')));
});
test('strict numeric and text limits', () => {
  for (const n of [-1,NaN,Infinity,1.5,'2',null]) assert.throws(() => integer(n,2,1,100));
  assert.equal(integer(undefined,2,1,100),2);
  assert.throws(() => text('中文','input',3)); assert.throws(() => text('x\0y','input'));
});
