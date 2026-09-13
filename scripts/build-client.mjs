#!/usr/bin/env bun
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)),dir=join(root,'packages/ultrabrain-client'),out=join(dir,'dist');mkdirSync(out,{recursive:true});
const result=await Bun.build({entrypoints:[join(dir,'src/cli.mjs')],outdir:out,naming:'cli.cjs',format:'cjs',target:'node',external:['@modelcontextprotocol/sdk/*'],minify:false,sourcemap:'none'});
if(!result.success){for(const log of result.logs)console.error(log.message);process.exit(1);}
const code=readFileSync(join(out,'cli.cjs'),'utf8');for(const forbidden of ['executeRaw','pg_advisory','Bun.','PersonalMemoryStore','/vendor/gbrain/'])if(code.includes(forbidden))throw Error('Server code leaked into client');
writeFileSync(join(out,'build-manifest.json'),JSON.stringify({format:1,version:JSON.parse(readFileSync(join(dir,'package.json'))).version,compiler:'Bun '+Bun.version,sdk:'1.29.0',sha256:createHash('sha256').update(code).digest('hex')},null,2)+'\n');
console.log('Built client-only CLI; SDK remains an external pinned dependency');
