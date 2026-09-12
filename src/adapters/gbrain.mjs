/** Versioned GBrain boundary. Structural compatibility is necessary, not proof of semantics. */
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {requireThat,sha256} from '../core.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const contract=JSON.parse(readFileSync(join(ROOT,'compat/gbrain-v1.json'),'utf8'));
// Recursively discard prose only. Required fields, defaults, enums and authorization
// classifications remain in the fingerprint; adding any native tool needs review.
function canonical(value) {
  if(Array.isArray(value)) return value.map(canonical);
  if(value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort()
    .filter(k=>k!=='description').map(k=>[k,canonical(value[k])]));
  return value;
}
export function catalog(operations) {
  requireThat(Array.isArray(operations),'upstream_contract_changed','Invalid native catalog');
  const result={};
  for(const op of operations) {
    requireThat(typeof op.name==='string' && !Object.hasOwn(result,op.name) && typeof op.handler==='function',
      'upstream_contract_changed','Invalid or duplicate native operation');
    const shape=canonical({scope:op.scope??'read',mutating:op.mutating===true,params:op.params??{}});
    result[op.name]=sha256(JSON.stringify(shape));
  }
  return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)));
}
export function compareCatalog(actual, expected) {
  const added=Object.keys(actual).filter(n=>!Object.hasOwn(expected,n));
  const removed=Object.keys(expected).filter(n=>!Object.hasOwn(actual,n));
  const changed=Object.keys(expected).filter(n=>Object.hasOwn(actual,n)&&expected[n]!==actual[n]);
  return {compatible:!(added.length||removed.length||changed.length),added,removed,changed};
}
export const loadNative=async path=>{
  requireThat(typeof path==='string' && !path.split('/').includes('..') && !path.startsWith('/'),
    'upstream_contract_changed','Invalid native module path');
  const file=join(ROOT,'vendor/gbrain',path);
  requireThat(existsSync(file),'upstream_file_missing',`Pinned native file missing: ${path}`);
  return import(file);
};
export async function nativeBindings({enforce=true}={}) {
  const [{operations},{validateParams},{OperationError},context]=await Promise.all([
    loadNative('src/core/operations.ts'),loadNative('src/mcp/dispatch.ts'),
    loadNative('src/core/ops/contract.ts'),loadNative('src/core/ops/context.ts')]);
  requireThat(typeof validateParams==='function' && typeof OperationError==='function' &&
    typeof context.enforceClientSlugFence==='function' && context.CLIENT_FENCED_WRITE_OPS instanceof Set,
    'upstream_contract_changed','Native validation or authorization exports changed');
  const actual=catalog(operations),report=compareCatalog(actual,contract.operations);
  const fences=[...context.CLIENT_FENCED_WRITE_OPS].sort();
  report.fences_compatible=JSON.stringify(fences)===JSON.stringify(contract.fenced_write_operations);
  report.compatible=report.compatible&&report.fences_compatible;
  if(enforce) requireThat(report.compatible,'upstream_contract_changed',
    'Native operation catalog changed; run compat and review the adapter contract before serving');
  const {AUDIT_ROW_SOURCES:auditSources}=await loadNative('src/core/facts/audit-sources.ts');
  requireThat(Array.isArray(auditSources)&&auditSources.length>0&&auditSources.every(x=>typeof x==='string'),'upstream_contract_changed','Audit source exclusions changed');
  return {operations,validateParams,OperationError,context,report,actual,fences,auditSources};
}
export async function compatibilityReport() {
  const {report,actual}=await nativeBindings({enforce:false});
  const pins=JSON.parse(readFileSync(join(ROOT,'upstreams.lock.json'),'utf8'));
  return {format:1,adapter:'gbrain-v1',reviewed_baseline:contract.reviewed_revision,
    candidate_revision:pins.projects.gbrain.revision,operations:Object.keys(actual).length,...report,
    assurance:'Structural contract only. Run real authorization, migration and behavior tests before release.'};
}
