import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUri, pack } from '../src/core.mjs';

test('URI paths use the native lowercase slug convention', () => {
  assert.equal(parseUri('ultra://default/Research/Agent').slug, 'research/agent');
});
for (const encoded of ['%C2%85','%E2%80%AE','%E2%81%A6'])
  test(`reject native-unsafe control or bidi ${encoded}`, () => assert.throws(() => parseUri(`ultra://default/${encoded}`)));
test('small evidence budgets retain a prefix instead of dropping the best hit', () => {
  const result = pack([{uri:'ultra://default/a',content:'中文🙂'.repeat(1000)}],512);
  assert.equal(result.items.length,1); assert.ok(result.items[0].content.length>0);
  assert.equal(result.budget_truncated_items,1); assert.ok(result.evidence_bytes<=512);
  assert.ok(!result.items[0].content.includes('\ufffd'));
});
test('evidence budget accounts for JSON escapes while shortening', () => {
  const result = pack([{uri:'ultra://default/a',content:'"\\\n'.repeat(1000)}],512);
  assert.equal(result.items.length,1); assert.ok(Buffer.byteLength(JSON.stringify(result.items))<=512);
});
