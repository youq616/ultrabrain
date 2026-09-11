import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentMemory } from '../src/agent-memory.mjs';

const wrapped = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const evidence = () => ({ items: [{ uri: 'ultra://default/resources/a', content: 'A remembered fact.' }], exhaustive: false });
function fixture(options = {}, handler) {
  const calls = [];
  const client = { async callTool(request, schema, requestOptions) {
    calls.push(request);
    if (handler) return handler(request, requestOptions);
    return wrapped(request.name === 'ultra_retrieve' ? evidence() : {
      state: 'needs_model', uri: 'ultra://default/sessions/actor/session/event', extraction: { skipped: 'extraction_unavailable' },
    });
  } };
  return { calls, memory: new AgentMemory({ client, rootUri: 'ultra://default/', sessionId: 'session', ...options }) };
}

test('capture is disabled unless explicitly enabled', async () => {
  const { memory, calls } = fixture();
  await assert.rejects(memory.afterTurn({ eventId: 'e', transcript: 'consented elsewhere' }), { code: 'capture_disabled' });
  assert.equal(calls.length, 0);
});
test('recall uses the configured source, level and byte budget', async () => {
  const { memory, calls } = fixture({ budgetBytes: 512 });
  const result = await memory.beforeTurn('question');
  assert.equal(calls[0].name, 'ultra_retrieve');
  assert.equal(calls[0].arguments.uri, 'ultra://default/');
  assert.equal(calls[0].arguments.budget_bytes, 512);
  assert.equal(result.trust, 'untrusted-memory-data');
});
test('foreign-source evidence is rejected before model invocation', async () => {
  const { memory } = fixture({}, () => wrapped({ items: [{ uri: 'ultra://secret/a', content: 'wrong scope' }] }));
  let generated = false;
  await assert.rejects(memory.runTurn({ input: 'hello', generate: async () => { generated = true; return 'reply'; } }), { code: 'scope_denied' });
  assert.equal(generated, false);
});
test('directory scope uses a segment boundary, not a string prefix', async () => {
  const { memory } = fixture({ rootUri: 'ultra://default/team' }, () => wrapped({ items: [{ uri: 'ultra://default/team-secret/a', content: 'wrong directory' }] }));
  await assert.rejects(memory.beforeTurn('hello'), { code: 'scope_denied' });
});
test('unsafe evidence URIs are rejected', async () => {
  const { memory } = fixture({}, () => wrapped({ items: [{ uri: 'ultra://default/a/../b', content: 'bad path' }] }));
  await assert.rejects(memory.beforeTurn('hello'), { code: 'invalid_uri' });
});
test('client verifies actual serialized evidence size', async () => {
  const { memory } = fixture({ budgetBytes: 512 }, () => wrapped({ items: [{ uri: 'ultra://default/a', content: 'x'.repeat(1000) }] }));
  await assert.rejects(memory.beforeTurn('hello'), { code: 'mcp_contract_changed' });
});
test('server errors do not expose raw provider diagnostics', async () => {
  const { memory } = fixture({}, () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'permission_denied', message: 'sensitive-provider-key' }) }] }));
  await assert.rejects(memory.beforeTurn('hello'), error => error.code === 'permission_denied' && !error.message.includes('sensitive-provider-key'));
});
test('invalid tool JSON fails closed', async () => {
  const { memory } = fixture({}, () => ({ content: [{ type: 'text', text: 'not JSON' }] }));
  await assert.rejects(memory.beforeTurn('hello'), { code: 'mcp_contract_changed' });
});
test('unconfigured extraction remains needs_model, not completed', async () => {
  const { memory, calls } = fixture({ capture: true });
  const receipt = await memory.afterTurn({ eventId: 'e', transcript: 'user approved transcript' });
  assert.equal(receipt.state, 'needs_model');
  assert.equal(calls[0].arguments.visibility, 'private');
  assert.equal(calls[0].arguments.session_id, 'session');
});
test('explicit visibility and retry are forwarded without elevating grants', async () => {
  const { memory, calls } = fixture({ capture: true });
  await memory.afterTurn({ eventId: 'e', transcript: 'text', visibility: 'world', retry: true });
  assert.equal(calls[0].arguments.visibility, 'world');
  assert.equal(calls[0].arguments.retry, true);
  assert.equal('auth' in calls[0].arguments, false);
});
test('concurrent identical event submissions share one MCP call', async () => {
  let resolve;
  const waiting = new Promise(r => { resolve = r; });
  const { memory, calls } = fixture({ capture: true }, () => waiting);
  const first = memory.afterTurn({ eventId: 'e', transcript: 'same' });
  const second = memory.afterTurn({ eventId: 'e', transcript: 'same' });
  await Promise.resolve();
  assert.equal(calls.length, 1);
  resolve(wrapped({ state: 'completed' }));
  assert.deepEqual(await first, await second);
  assert.equal(memory.pending.size, 0);
});
test('concurrent event ID reuse with changed content is rejected', async () => {
  let resolve;
  const { memory } = fixture({ capture: true }, () => new Promise(r => { resolve = r; }));
  const first = memory.afterTurn({ eventId: 'e', transcript: 'first' });
  await assert.rejects(memory.afterTurn({ eventId: 'e', transcript: 'changed' }), { code: 'conflict' });
  resolve(wrapped({ state: 'completed' }));
  await first;
});
test('in-flight submissions are bounded', async () => {
  let resolve;
  const { memory } = fixture({ capture: true, maxPending: 1 }, () => new Promise(r => { resolve = r; }));
  const first = memory.afterTurn({ eventId: 'e1', transcript: 'first' });
  await assert.rejects(memory.afterTurn({ eventId: 'e2', transcript: 'second' }), { code: 'busy' });
  resolve(wrapped({ state: 'completed' }));
  await first;
});
test('timeout bounds a transport that ignores cancellation', async () => {
  const { memory } = fixture({ timeoutMs: 10 }, () => new Promise(() => {}));
  await assert.rejects(memory.beforeTurn('hello'), { code: 'mcp_timeout' });
});
test('already aborted requests are not submitted', async () => {
  const { memory, calls } = fixture();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(memory.beforeTurn('hello', { signal: controller.signal }), { code: 'cancelled' });
  assert.equal(calls.length, 0);
});
test('automatic lifecycle recalls before generation and captures afterwards', async () => {
  const { memory, calls } = fixture({ capture: true });
  const result = await memory.runTurn({ input: 'question', eventId: 'turn1', generate: async ({ input, evidence }) => {
    assert.equal(input, 'question');
    assert.equal(calls.length, 1);
    assert.equal(evidence.items.length, 1);
    return 'answer';
  } });
  assert.equal(result.output, 'answer');
  assert.equal(result.capture.confirmed, true);
  assert.equal(calls[1].name, 'ultra_commit_session');
  assert.deepEqual(JSON.parse(calls[1].arguments.transcript), { user: 'question', assistant: 'answer' });
});
test('read-only lifecycle does not save conversations', async () => {
  const { memory, calls } = fixture();
  const result = await memory.runTurn({ input: 'hello', generate: async () => 'reply' });
  assert.equal(result.capture.enabled, false);
  assert.equal(calls.length, 1);
});
test('failed generation does not save a partial conversation', async () => {
  const { memory, calls } = fixture({ capture: true });
  await assert.rejects(memory.runTurn({ input: 'hello', eventId: 'e', generate: async () => { throw new Error('generation failed'); } }), /generation failed/);
  assert.equal(calls.length, 1);
});
test('persistence failure preserves output and never retries the model', async () => {
  const { memory } = fixture({ capture: true }, request => {
    if (request.name === 'ultra_retrieve') return wrapped(evidence());
    throw new Error('transport failed');
  });
  let generations = 0;
  const result = await memory.runTurn({ input: 'hello', eventId: 'e', generate: async () => { generations++; return 'valuable result'; } });
  assert.equal(result.output, 'valuable result');
  assert.equal(result.capture.confirmed, false);
  assert.equal(result.capture.state, 'unconfirmed');
  assert.equal(generations, 1);
});
test('oversized transcripts are not silently truncated or submitted', async () => {
  const { memory, calls } = fixture({ capture: true });
  const result = await memory.runTurn({ input: 'hello', eventId: 'e', generate: async () => 'x'.repeat(70000) });
  assert.equal(result.output.length, 70000);
  assert.equal(result.capture.state, 'not_submitted');
  assert.equal(calls.length, 1);
});
test('long input uses an explicitly marked UTF-8-safe retrieval prefix', async () => {
  const { memory, calls } = fixture();
  const result = await memory.runTurn({ input: '中'.repeat(1500), generate: async () => 'reply' });
  assert.equal(result.query_truncated, true);
  assert.ok(Buffer.byteLength(calls[0].arguments.query) <= 4096);
  assert.ok(!calls[0].arguments.query.includes('\ufffd'));
});
test('invalid identifiers and non-boolean capture are rejected', () => {
  assert.throws(() => fixture({ sessionId: '../other' }), { code: 'invalid_params' });
  assert.throws(() => fixture({ capture: 'yes' }), { code: 'invalid_params' });
});
