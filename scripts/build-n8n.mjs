#!/usr/bin/env bun
/** Build only the client adapter, leaving n8n and the pinned official MCP SDK external. */
import {readFileSync,mkdirSync,copyFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=join(root,'packages/n8n-nodes-ultrabrain');
const dest=join(dir,'dist');mkdirSync(dest,{recursive:true});
const result=await Bun.build({entrypoints:[join(dir,'src/runtime.mjs')],target:'node',format:'cjs',
  external:['@modelcontextprotocol/sdk/*'],outdir:dest,naming:'runtime.cjs',minify:false,sourcemap:'none'});
if(!result.success) {console.error('n8n adapter build failed');process.exit(1);}
for(const relative of ['credentials/UltrabrainApi.credentials.js','nodes/Ultrabrain/Ultrabrain.node.js']) {
  mkdirSync(join(dest,relative,'..'),{recursive:true});copyFileSync(join(dir,relative),join(dest,relative));
}
const code=readFileSync(join(dest,'runtime.cjs'),'utf8');
for(const forbidden of ['pg_advisory','executeRaw','child_process','Bun.','/vendor/gbrain/','SESSION_SCHEMA'])
  if(code.includes(forbidden))throw new Error('Server implementation leaked into client build: '+forbidden);
const sdk=JSON.parse(readFileSync(join(dir,'package.json'),'utf8')).dependencies['@modelcontextprotocol/sdk'];
writeFileSync(join(dest,'build-manifest.json'),JSON.stringify({format:1,version:JSON.parse(readFileSync(join(dir,'package.json'),'utf8')).version,
  sdk,compiler:'Bun '+Bun.version,runtime_sha256:createHash('sha256').update(code).digest('hex'),
  scope:'Self-hosted n8n client package; no DB, host runner, credentials or model runtime bundled'},null,2)+'\n');
console.log('Built private n8n adapter with external SDK '+sdk);
