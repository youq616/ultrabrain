import test from 'node:test';
import assert from 'node:assert/strict';
import {validateHistory,checksum,migrations} from '../src/migrations.mjs';
test('new install and adopted baseline have explicit pending migrations',()=>{
  assert.equal(validateHistory([]).length,1);
  assert.deepEqual(validateHistory(migrations.map(m=>({id:m.id,checksum:checksum(m)}))),[]);
});
test('unknown history, gaps and changed migrations are rejected',()=>{
  assert.throws(()=>validateHistory([{id:'9999-future',checksum:'a'.repeat(64)}]),{code:'migration_unknown'});
  assert.throws(()=>validateHistory([{id:migrations[0].id,checksum:'a'.repeat(64)}]),{code:'migration_checksum_mismatch'});
});
test('duplicate or unordered migration plans are rejected',()=>{
  assert.throws(()=>validateHistory([],[migrations[0],migrations[0]]),{code:'migration_invalid'});
});
