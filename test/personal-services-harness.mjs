/** Safe fixture control contracts, not an alternate systemd implementation. */
import assert from 'node:assert/strict';

export function requireMissingUnit(result) {
  assert.ok(result && [0, 5].includes(result.code), 'Cannot determine unit absence');
  assert.equal(typeof result.text, 'string', 'Missing unit properties');
  const props = new Map();
  for (const line of result.text.trim().split('\n')) {
    const index = line.indexOf('=');
    assert.ok(index > 0, 'Malformed unit property');
    const key = line.slice(0, index), value = line.slice(index + 1);
    assert.ok(['LoadState', 'ActiveState', 'FragmentPath'].includes(key) && !props.has(key),
      'Unexpected or repeated unit property');
    props.set(key, value);
  }
  assert.equal(props.size, 3, 'Incomplete unit state');
  assert.equal(props.get('LoadState'), 'not-found', 'An existing unit makes this test unsafe');
  assert.equal(props.get('ActiveState'), 'inactive', 'A live unit makes this test unsafe');
  assert.equal(props.get('FragmentPath'), '', 'Never replace an existing unit file');
}

/** Always attempt shutdown; delete fixture files only after every cleanup succeeds. */
export async function cleanupFixture({shutdown, unlink, reload, remove}) {
  let failures = 0;
  for (const operation of shutdown) {
    try { await operation(); } catch { failures++; }
  }
  if (!failures) {
    for (const operation of unlink) {
      try { await operation(); } catch { failures++; }
    }
    try { await reload(); } catch { failures++; }
  }
  assert.equal(failures, 0, 'Fixture cleanup failed; private export retained, not accepted');
  await remove();
}
