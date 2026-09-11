/** Linux/local-filesystem journal. No second memory database, no stored credentials.
 * Delivery is at least once. Server receipt keys, NOT a local mutex, deduplicate writes.
 * Multiple drainers may submit the same event. An immutable ACK always wins over retries.
 */
import { constants, mkdirSync, lstatSync, openSync, closeSync, readFileSync,
  writeFileSync, fsyncSync, linkSync, unlinkSync, readdirSync, fstatSync, renameSync } from 'node:fs';
import { resolve, join, dirname, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat, text, integer, sha256, parseUri, UltraError } from './core.mjs';

function id(value) {
  requireThat(typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value), 'invalid_params', 'Invalid event/session id');
  return value;
}
function secureDirectory(path) {
  // Reject symlink ancestors, not just the final component. Shared parent directories
  // such as /tmp are allowed; the journal itself must be private and owned by us.
  let cursor = resolve(path);
  while (cursor !== parse(cursor).root) {
    try { requireThat(!lstatSync(cursor).isSymbolicLink(), 'insecure_outbox', 'Symlinked journal path'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    cursor = dirname(cursor);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  requireThat(st.isDirectory() && st.uid === process.getuid() && !(st.mode & 0o077),
    'insecure_outbox', 'Outbox must be owned by this user with mode 0700');
}
function readPrivate(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    requireThat(st.isFile() && st.uid === process.getuid() && !(st.mode & 0o077),
      'insecure_outbox', 'Outbox records must be private regular files');
    requireThat(st.size <= 131072, 'outbox_corrupt', 'Oversized journal record');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { if (fd !== undefined) closeSync(fd); }
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function createImmutable(path, value) {
  const temp = join(dirname(path), `.pending-${randomUUID()}`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    try { linkSync(temp, path); syncDirectory(dirname(path)); return true; }
    catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  } finally { unlinkSync(temp); syncDirectory(dirname(path)); }
}
function replacePrivate(path, value) {
  const temp = join(dirname(path), `.retry-${randomUUID()}`);
  try { createImmutable(temp, value); renameSync(temp, path); syncDirectory(dirname(path)); }
  finally { try { unlinkSync(temp); } catch(e) { if(e.code !== 'ENOENT') throw e; } }
}
const transient = new Set(['mcp_timeout','transport_error','busy','lease_lost','cancelled','unavailable','ECONNRESET','ECONNREFUSED','ETIMEDOUT']);
const safeCode = e => typeof e?.code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(e.code) ? e.code : 'transport_error';

export class DurableOutbox {
  constructor({ directory, rootUri, principalId, serverId, maxEvents = 10000 } = {}) {
    text(directory, 'directory', 4096); text(principalId, 'principalId', 256); text(serverId, 'serverId', 512);
    this.directory = resolve(directory);
    secureDirectory(this.directory);
    this.binding = { format: 1, root_uri: parseUri(rootUri).uri, principal: principalId, server: serverId };
    this.maxEvents = integer(maxEvents, 10000, 1, 100000);
    const path = join(this.directory, 'binding.json');
    createImmutable(path, this.binding);
    requireThat(JSON.stringify(readPrivate(path)) === JSON.stringify(this.binding),
      'outbox_binding_mismatch', 'Use a separate outbox for each server, source/root and stable principal');
  }
  key(event) { return sha256(JSON.stringify([this.binding, id(event.session_id), id(event.event_id)])); }
  path(key, kind) { return join(this.directory, `${key}.${kind}.json`); }
  optional(key, kind) {
    try { return readPrivate(this.path(key, kind)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  enqueue(input) {
    id(input.session_id); id(input.event_id); text(input.transcript, 'transcript', 65536);
    requireThat(['private','world'].includes(input.visibility), 'invalid_params', 'Invalid capture visibility');
    const payload = { session_id: input.session_id, event_id: input.event_id,
      transcript: input.transcript, visibility: input.visibility };
    const key = this.key(payload), digest = sha256(JSON.stringify(payload));
    const ack = this.optional(key, 'ack');
    if (ack) {
      requireThat(ack.digest === digest, 'conflict', 'Event id already acknowledged with different content');
      return { key, queued: false, acknowledged: true, state: ack.state, receipt: ack };
    }
    if (!this.optional(key,'event')) requireThat(this.keys().length < this.maxEvents, 'outbox_full', 'Drain the outbox before accepting more events');
    const record = { format: 1, key, digest, payload, enqueued_at: new Date().toISOString() };
    if (!createImmutable(this.path(key, 'event'), record)) {
      requireThat(this.optional(key, 'event')?.digest === digest, 'conflict', 'Event id already queued with different content');
    }
    // The producer count cap is advisory under concurrency, not a filesystem quota.
    // Already durable unacknowledged events are never evicted to make space.
    return { key, queued: true, acknowledged: false };
  }
  keys() {
    return readdirSync(this.directory).filter(n => /^[a-f0-9]{64}\.event\.json$/.test(n))
      .map(n => n.slice(0,64)).sort();
  }
  inspect() {
    const items = [];
    for (const key of this.keys()) {
      const event = this.optional(key,'event'); if (!event) continue;
      const ack = this.optional(key,'ack'), retry = this.optional(key,'retry');
      items.push({ key, session_id: event.payload.session_id, event_id: event.payload.event_id,
        state: ack ? ack.state : 'pending', retry, enqueued_at: event.enqueued_at });
    }
    return { binding: this.binding, pending: items.filter(x => x.state === 'pending').length, items };
  }
  acknowledge(key, digest, receipt) {
    requireThat(['completed','needs_model'].includes(receipt?.state) && typeof receipt.uri === 'string',
      'unconfirmed_capture', 'Server has not confirmed durable session storage');
    requireThat(parseUri(receipt.uri).source === parseUri(this.binding.root_uri).source, 'scope_denied', 'Receipt source mismatch');
    const ack = { key, digest, state: receipt.state, uri: receipt.uri,
      storage: 'stored', extraction: receipt.state === 'completed' ? 'completed' : 'needs_model',
      acknowledged_at: new Date().toISOString() };
    createImmutable(this.path(key,'ack'), ack);
    requireThat(this.optional(key,'ack')?.digest === digest, 'conflict', 'Receipt digest conflict');
    // ACK remains a small idempotency tombstone; no transcript is retained in it.
    try { unlinkSync(this.path(key,'event')); syncDirectory(this.directory); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    return ack;
  }
  async flush(send, { limit = 32, signal, force = false, maxAttempts = 10 } = {}) {
    requireThat(typeof send === 'function', 'invalid_params', 'A bound send callback is required');
    integer(limit, 32, 1, 1000);
    integer(maxAttempts,10,1,100);
    const results = []; let deferred = 0;
    for (const key of this.keys()) {
      if (results.length >= limit) break;
      if (signal?.aborted) break;
      const event = this.optional(key,'event'); if (!event) continue;
      requireThat(event.key === key && event.digest === sha256(JSON.stringify(event.payload)) && this.key(event.payload) === key,
        'outbox_corrupt', 'Outbox content hash mismatch');
      const ack = this.optional(key,'ack');
      if (ack) { this.acknowledge(key,event.digest,ack); results.push({ key, state: ack.state, replayed: true }); continue; }
      const retry = this.optional(key,'retry');
      if (!force && retry && (retry.blocked || retry.next_at > Date.now())) { deferred++; continue; }
      try {
        const receipt = await send({ ...event.payload, retry: true }, signal);
        this.acknowledge(key,event.digest,receipt);
        results.push({ key, state: receipt.state, storage: 'stored' });
      } catch (e) {
        const code = safeCode(e);
        const attempts = (force ? 0 : retry?.attempts ?? 0) + 1;
        const blocked = !transient.has(code) || attempts >= maxAttempts;
        replacePrivate(this.path(key,'retry'), { attempts, blocked, error: code,
          next_at: Date.now() + Math.min(300000, 1000 * 2 ** Math.min(attempts,9)) });
        // No exception message, transcript, credentials or provider response in telemetry.
        results.push({ key, state: 'pending', error: code, retryable: transient.has(code) });
      }
    }
    return { results, deferred, delivery: 'at-least-once', retry_policy: 'explicit drain or next runTurn' };
  }
}
