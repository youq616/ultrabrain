/** Pure, dependency-free context primitives. No database or provider access. */
import { createHash } from 'node:crypto';
export class UltraError extends Error {
  constructor(code, message) { super(message); this.name = 'UltraError'; this.code = code; }
}
export function requireThat(condition, code, message) {
  if (!condition) throw new UltraError(code, message);
}
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function integer(value, fallback, min, max) {
  if (value === undefined) return fallback;
  requireThat(Number.isInteger(value) && value >= min && value <= max,
    'invalid_params', `Expected an integer between ${min} and ${max}`);
  return value;
}
export function text(value, name, max = 262144) {
  requireThat(typeof value === 'string' && value.isWellFormed() && value.trim().length > 0 &&
    Buffer.byteLength(value, 'utf8') <= max && !value.includes('\0'),
    'invalid_params', `${name} must be nonempty UTF-8 text, at most ${max} bytes, without NUL`);
  return value;
}
export function sourceId(value) {
  requireThat(typeof value === 'string' && /^[a-z0-9-]{1,32}$/.test(value),
    'invalid_params', 'Invalid source id');
  return value;
}
function segment(value) {
  requireThat(value && value !== '.' && value !== '..' &&
    !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\\/%?#]/u.test(value), 'invalid_uri', 'Unsafe URI segment');
  return value.normalize('NFC').toLowerCase();
}
export function uri(source, slug = '') {
  sourceId(source);
  requireThat(typeof slug === 'string' && Buffer.byteLength(slug) <= 2048, 'invalid_uri', 'Invalid path');
  const path = slug ? slug.split('/').map(segment).map(encodeURIComponent).join('/') : '';
  return `ultra://${source}/${path}`;
}
export function parseUri(value) {
  text(value, 'uri', 8192);
  // Validate raw segments BEFORE URL normalization could erase traversal.
  const m = /^ultra:\/\/([a-z0-9-]{1,32})\/(.*)$/u.exec(value);
  requireThat(m && !/[?#\\\x00-\x20\x7f]/u.test(value), 'invalid_uri', 'Expected ultra://source/path');
  let path;
  try { path = m[2] ? m[2].split('/').map(x => segment(decodeURIComponent(x))).join('/') : ''; }
  catch { throw new UltraError('invalid_uri', 'Unsafe or malformed URI encoding'); }
  requireThat(Buffer.byteLength(path) <= 2048, 'invalid_uri', 'Path is too long');
  return { source: m[1], slug: path, uri: uri(m[1], path) };
}
export function within(slug, prefix) {
  return !prefix || slug === prefix || slug.startsWith(prefix + '/');
}
/** UTF-8 byte limit, never splits a Unicode scalar. Not an exact model tokenizer. */
export function clip(value, maxBytes) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
export function layers(page, level = 'L0', maxBytes = 65536) {
  requireThat(['L0', 'L1', 'L2'].includes(level), 'invalid_params', 'level must be L0, L1 or L2');
  const canonical = typeof page.content === 'string' ? page.content : page.compiled_truth ?? '';
  const body = page.compiled_truth ?? canonical;
  const limit = Math.min(maxBytes, level === 'L0' ? 384 : level === 'L1' ? 3072 : maxBytes);
  const original = level === 'L2' ? canonical : `${page.title ?? ''}\n${body}`;
  const content = clip(original, limit);
  return {
    uri: uri(page.source_id, page.slug), level, content,
    summary_method: level === 'L2' ? 'canonical' : 'extractive-prefix-v1',
    content_sha256: sha256(canonical), updated_at: page.updated_at,
    bytes: Buffer.byteLength(content), truncated: content !== original,
    trust: 'untrusted-memory-data',
  };
}
/** Deterministic directory-assisted reranking of ALREADY AUTHORIZED native hits. */
export function rankHierarchy(hits, prefix = '', limit = 10) {
  const unique = new Map();
  for (let rank = 0; rank < hits.length; rank++) {
    const hit = hits[rank];
    if (!hit || typeof hit.slug !== 'string' || !within(hit.slug, prefix)) continue;
    const id = `${hit.source_id}\0${hit.slug}`;
    if (!unique.has(id)) unique.set(id, { ...hit, native_rank: rank + 1 });
  }
  const candidates = [...unique.values()];
  const branches = new Map();
  for (const hit of candidates) {
    const rel = prefix ? hit.slug.slice(prefix.length).replace(/^\//, '') : hit.slug;
    hit.branch = rel.split('/')[0] || hit.slug;
    branches.set(hit.branch, (branches.get(hit.branch) ?? 0) + 1 / (60 + hit.native_rank));
  }
  return candidates.map(hit => ({ ...hit,
    hierarchy_score: 1 / (60 + hit.native_rank) + 0.15 * branches.get(hit.branch),
  })).sort((a, b) => b.hierarchy_score - a.hierarchy_score || a.native_rank - b.native_rank)
    .slice(0, limit);
}
/** Bounds the entire serialized evidence array, including metadata and citations. */
export function pack(items, maxBytes) {
  integer(maxBytes, undefined, 2, 1048576);
  const selected = [];
  const fits = item => Buffer.byteLength(JSON.stringify([...selected, item])) <= maxBytes;
  let shortened = 0;
  for (const item of items) {
    if (fits(item)) { selected.push(item); continue; }
    if (typeof item.content !== 'string') continue;
    // Keep higher-ranked evidence when its metadata plus a readable prefix fits.
    // Binary search counts the ACTUAL escaped JSON, not just raw content bytes.
    let lo = 0, hi = Buffer.byteLength(item.content), best = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const content = clip(item.content, mid);
      const candidate = { ...item, content, bytes: Buffer.byteLength(content),
        truncated: true, budget_truncated: true };
      if (fits(candidate)) { best = candidate; lo = mid + 1; } else hi = mid - 1;
    }
    if (best?.content) { selected.push(best); shortened++; }
  }
  return { items: selected, evidence_bytes: Buffer.byteLength(JSON.stringify(selected)),
    evidence_budget_bytes: maxBytes, dropped: items.length - selected.length,
    budget_truncated_items: shortened,
    budget_unit: 'UTF-8 bytes; response envelope excluded; not model tokens' };
}
