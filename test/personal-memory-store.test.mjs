import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMemory } from '../src/personal-memory-store.mjs';

test('normalizes supported personal memory objects', () => {
  const memory = normalizeMemory({type:'preference', content:'User prefers CLI workflows', confidence:0.9});
  assert.equal(memory.type,'preference');
  assert.equal(memory.status,'active');
  assert.match(memory.hash,/^[a-f0-9]{64}$/);
});

test('rejects unknown personal memory types', () => {
  assert.throws(()=>normalizeMemory({type:'unknown',content:'x'}));
});

test('rejects invalid confidence values', () => {
  assert.throws(()=>normalizeMemory({type:'skill',content:'x',confidence:2}));
});
