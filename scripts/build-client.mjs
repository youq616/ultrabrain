#!/usr/bin/env bun
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=join(root,'packages/ultrabrain-client'),out=join(dir,'dist');mkdirSync(out,{recursive:true});
const result=await Bun.build({entrypoints:[join(dir,'src/cli.mjs')],outdir:out,naming:'cli.cjs',format:'cjs',target:'node',external:['@modelcontextprotocol/sdk/*'],minify:false,sourcemap:'none'});
if(!result.success){for(const log of result.logs)console.error(log.message);process.exit(1);}
for(const [entry,name] of [['snapshot.mjs','snapshot.cjs'],['snapshot-cli.mjs','snapshot-cli.cjs'],['lineage.mjs','lineage.cjs'],['native-adapters.mjs','native-adapters.cjs'],['openclaw.mjs','openclaw.cjs']]) {
  const built=await Bun.build({entrypoints:[join(dir,'src',entry)],outdir:out,naming:name,format:'cjs',target:'node',external:['@modelcontextprotocol/sdk/*'],minify:false,sourcemap:'none'});
  if(!built.success)throw new Error('Native adapter build failed');
}
const hashes={};
for(const name of ['cli.cjs','native-adapters.cjs','openclaw.cjs','lineage.cjs','snapshot.cjs','snapshot-cli.cjs']) {
  const code=readFileSync(join(out,name),'utf8');
  for(const forbidden of ['executeRaw','pg_advisory','Bun.','PersonalMemoryStore','/vendor/gbrain/'])
    if(code.includes(forbidden))throw Error('Server code leaked into client '+name);
  if(name.startsWith('snapshot'))for(const forbidden of ['@modelcontextprotocol/sdk','connectClient','readClientProfile','node:child_process','node:http','node:net','node:tls','fetch('])
    if(code.includes(forbidden))throw Error('Online capability leaked into offline bundle '+name);
  hashes[name]=createHash('sha256').update(code).digest('hex');
}
writeFileSync(join(out,'build-manifest.json'),JSON.stringify({format:1,version:JSON.parse(readFileSync(join(dir,'package.json'))).version,
  compiler:'Bun '+Bun.version,sdk:'1.29.0',sha256:hashes['cli.cjs'],artifacts:hashes},null,2)+'\n');
console.log('Built client-only CLI and native adapters; SDK remains an external pinned dependency');
