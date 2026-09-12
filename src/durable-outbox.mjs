/** Linux/local-filesystem journal. At-least-once delivery; ACK tombstones win over retries. */
import { constants, mkdirSync, lstatSync, openSync, closeSync, readFileSync,
  writeFileSync, fsyncSync, linkSync, unlinkSync, readdirSync, fstatSync, renameSync } from 'node:fs';
import { resolve, join, dirname, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat, text, integer, sha256, parseUri, UltraError } from './core.mjs';
export const MAX_RECORD_BYTES = 512 * 1024;
const isolatedErrors = new Set(['outbox_corrupt', 'insecure_outbox', 'ELOOP']);
function encodeRecord(value) {
  const encoded = JSON.stringify(value);
  requireThat(typeof encoded === 'string' && Buffer.byteLength(encoded) <= MAX_RECORD_BYTES,
    'outbox_record_too_large', 'Serialized journal record exceeds the envelope limit');
  return encoded;
}
function id(value) {
  requireThat(typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value), 'invalid_params', 'Invalid event/session id');
  return value;
}
function secureDirectory(path) {
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
    requireThat(st.size <= MAX_RECORD_BYTES, 'outbox_corrupt', 'Oversized journal record');
    try { return JSON.parse(readFileSync(fd, 'utf8')); }
    catch (e) { if (e instanceof SyntaxError) throw new UltraError('outbox_corrupt', 'Invalid journal JSON'); throw e; }
  } finally { if (fd !== undefined) closeSync(fd); }
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function createImmutable(path, value) {
  const encoded = encodeRecord(value);
  const temp = join(dirname(path), `.pending-${randomUUID()}`);
  let fd;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, encoded); fsyncSync(fd); closeSync(fd); fd = undefined;
    try { linkSync(temp, path); syncDirectory(dirname(path)); return true; }
    catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); syncDirectory(dirname(path)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
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
  path(key, kind) {
    requireThat(/^[a-f0-9]{64}$/.test(key) && ['event','ack','retry','quarantine'].includes(kind),
      'invalid_params', 'Invalid journal record address');
    return join(this.directory, `${key}.${kind}.json`);
  }
  optional(key, kind) {
    try { return readPrivate(this.path(key, kind)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  enqueue(input) {
    id(input.session_id); id(input.event_id); text(input.transcript, 'transcript', 65536);
    requireThat(['private','world'].includes(input.visibility), 'invalid_params', 'Invalid capture visibility');
    requireThat(input.defer_extraction === undefined || typeof input.defer_extraction === 'boolean', 'invalid_params', 'Invalid processing mode');
    const payload = { session_id: input.session_id, event_id: input.event_id,
      transcript: input.transcript, visibility: input.visibility, ...(input.defer_extraction === true ? {defer_extraction:true} : {}) };
    const key = this.key(payload), digest = sha256(JSON.stringify(payload));
    requireThat(!this.isQuarantined(key), 'outbox_quarantined', 'Review the quarantined record before reusing this event');
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
    return { key, queued: true, acknowledged: false };
  }
  keys() {
    return readdirSync(this.directory).filter(n => /^[a-f0-9]{64}\.event\.json$/.test(n))
      .map(n => n.slice(0,64)).sort();
  }
  isQuarantined(key) {
    try { lstatSync(this.path(key,'quarantine')); return true; }
    catch(e) { if(e.code === 'ENOENT') return false; throw e; }
  }
  quarantine(key, error) {
    if (!isolatedErrors.has(error.code)) throw error;
    createImmutable(this.path(key,'quarantine'), {format:1,key,state:'quarantined',
      error:safeCode(error),detected_at:new Date().toISOString()});
    return {key,state:'quarantined',error:safeCode(error)};
  }
  validatedEvent(key) {
    const event = this.optional(key,'event');
    if (!event) return null;
    let valid = false;
    try {
      valid = event.format === 1 && event.key === key &&
        event.digest === sha256(JSON.stringify(event.payload)) && this.key(event.payload) === key &&
        ['private','world'].includes(event.payload.visibility) &&
        !!text(event.payload.transcript,'transcript',65536);
    } catch {}
    requireThat(valid,'outbox_corrupt','Invalid event structure or digest');
    return event;
  }
  validatedAck(key, digest) {
    const ack = this.optional(key,'ack');
    if (!ack) return null;
    let valid = false;
    try { valid = ack.key === key && ack.digest === digest &&
      (ack.deferred === true ? ack.storage === 'journaled' && ['queued','processing','completed','needs_model','failed'].includes(ack.state) : ['completed','needs_model'].includes(ack.state)) &&
      parseUri(ack.uri).source === parseUri(this.binding.root_uri).source; } catch {}
    requireThat(valid,'outbox_corrupt','Invalid ACK structure, digest or source');
    return ack;
  }
  validatedRetry(key) {
    const retry = this.optional(key,'retry');
    requireThat(!retry || (Number.isInteger(retry.attempts) && retry.attempts >= 0 &&
      typeof retry.blocked === 'boolean' && Number.isFinite(retry.next_at) &&
      typeof retry.error === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(retry.error)),
      'outbox_corrupt','Invalid retry record');
    return retry;
  }
  inspect() {
    const items = [];
    for (const key of this.keys()) {
      if (this.isQuarantined(key)) {items.push({key,state:'quarantined'});continue;}
      try {
        const event = this.validatedEvent(key); if (!event) continue;
        const ack = this.validatedAck(key,event.digest), retry = this.validatedRetry(key);
        items.push({key,session_id:event.payload.session_id,event_id:event.payload.event_id,
          state:ack ? ack.state : 'pending',retry,enqueued_at:event.enqueued_at});
      } catch(e) {
        if (!isolatedErrors.has(e.code)) throw e;
        items.push({key,state:'corrupt',error:safeCode(e)});
      }
    }
    return {binding:this.binding,pending:items.filter(x=>x.state==='pending').length,
      quarantined:items.filter(x=>['quarantined','corrupt'].includes(x.state)).length,items};
  }
  acknowledge(key, digest, receipt) {
    const event=this.optional(key,'event');
    const deferred=event?.payload?.defer_extraction === true || this.optional(key,'ack')?.deferred === true;
    requireThat((deferred ? receipt?.deferred === true && receipt.storage === 'journaled' && ['queued','processing','completed','needs_model','failed'].includes(receipt.state) : ['completed','needs_model'].includes(receipt?.state)) && typeof receipt.uri === 'string',
      'unconfirmed_capture', 'Server has not confirmed durable session storage');
    requireThat(parseUri(receipt.uri).source === parseUri(this.binding.root_uri).source, 'scope_denied', 'Receipt source mismatch');
    const ack = { key, digest, state: receipt.state, uri: receipt.uri,
      storage: deferred ? 'journaled' : 'stored', ...(deferred ? {deferred:true} : {}), extraction: receipt.state,
      acknowledged_at: new Date().toISOString() };
    createImmutable(this.path(key,'ack'), ack);
    requireThat(this.optional(key,'ack')?.digest === digest, 'conflict', 'Receipt digest conflict');
    try { unlinkSync(this.path(key,'event')); syncDirectory(this.directory); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    return ack;
  }
  async flush(send, { limit = 32, signal, force = false, maxAttempts = 10 } = {}) {
    requireThat(typeof send === 'function', 'invalid_params', 'A bound send callback is required');
    integer(limit, 32, 1, 1000);
    integer(maxAttempts,10,1,100);
    const results = []; let deferred = 0, quarantined = 0;
    for (const key of this.keys()) {
      if (results.length >= limit || signal?.aborted) break;
      if (this.isQuarantined(key)) {quarantined++;continue;}
      try {
        const event = this.validatedEvent(key); if (!event) continue;
        const ack = this.validatedAck(key,event.digest);
        if (ack) { this.acknowledge(key,event.digest,ack); results.push({key,state:ack.state,replayed:true}); continue; }
        const retry = this.validatedRetry(key);
        if (!force && retry && (retry.blocked || retry.next_at > Date.now())) { deferred++; continue; }
        try {
          const receipt = await send({...event.payload,retry:true}, signal);
          this.acknowledge(key,event.digest,receipt);
          results.push({key,state:receipt.state,storage:receipt.storage??'stored'});
        } catch(e) {
          if (isolatedErrors.has(e.code)) throw e;
          const code = safeCode(e), attempts = (force ? 0 : retry?.attempts ?? 0) + 1;
          const blocked = !transient.has(code) || attempts >= maxAttempts;
          replacePrivate(this.path(key,'retry'), {attempts,blocked,error:code,
            next_at:Date.now()+Math.min(300000,1000*2**Math.min(attempts,9))});
          results.push({key,state:'pending',error:code,retryable:transient.has(code)});
        }
      } catch(e) { results.push(this.quarantine(key,e)); quarantined++; }
    }
    return {results,deferred,quarantined,delivery:'at-least-once',retry_policy:'explicit drain or next runTurn'};
  }
}
