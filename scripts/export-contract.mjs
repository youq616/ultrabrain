/** Emits a proposed contract to stdout; never overwrites the reviewed contract. */
import {readFileSync} from 'node:fs';
import {contract,nativeBindings} from '../src/adapters/gbrain.mjs';
const {actual,fences}=await nativeBindings({enforce:false});
const {projects}=JSON.parse(readFileSync(new URL('../upstreams.lock.json',import.meta.url),'utf8'));
console.log(JSON.stringify({...contract,reviewed_revision:projects.gbrain.revision,
  operations:actual,fenced_write_operations:fences},null,2));
