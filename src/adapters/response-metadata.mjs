/** Reviewed in-memory adapter, not a modification of the pinned vendor checkout.
 * Ultrabrain tools already return budgeted, authorized evidence. Never append a
 * second native hot-fact channel that has not passed their policy/prefix checks.
 */
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {sha256,requireThat} from '../core.mjs';
export const META_HOOK_SHA256='1c289d7c89f974dee0419f5cb0df606d9cf446180bd56c2dbc5d31f9d3cbaca6';
const anchor="  if (name === 'recall' || name === 'extract_facts' || name === 'forget_fact') return undefined;";
export function guardMetadataSource(source) {
  requireThat(sha256(source)===META_HOOK_SHA256 && source.split(anchor).length===2,
    'upstream_contract_changed','Native response metadata changed; review this adapter before serving');
  return source.replace(anchor,"  if (name.startsWith('ultra_')) return undefined; // Ultrabrain owns its governed evidence channel.\n"+anchor);
}
let installed=false;
export function installResponseMetadataGuard(root) {
  if(installed)return;
  requireThat(typeof Bun!=='undefined','bun_required','Native response guard requires the managed Bun runtime');
  const target=resolve(join(root,'vendor/gbrain/src/core/facts/meta-hook.ts'));
  // Validate before importing ANY native module, including operation registries.
  guardMetadataSource(readFileSync(target,'utf8'));
  Bun.plugin({name:'ultrabrain-governed-response-metadata-v1',setup(build){
    build.onLoad({filter:/[/\\]facts[/\\]meta-hook\.ts$/},args=>{
      if(resolve(args.path)!==target)return;
      return {contents:guardMetadataSource(readFileSync(target,'utf8')),loader:'ts'};
    });
  }});
  installed=true;
}
