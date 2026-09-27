/** Actual Node package resolution in controlled hoisted and nested layouts. */
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
import {memoryReadBarrierPreload} from './helpers/installed-client-preload.mjs';
for(const layout of ['hoisted','nested'])test('installed race preload: '+layout+' resolves same public SDK as compiled entry',t=>{
 const dir=mkdtempSync(join(tmpdir(),'ub-layout-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const pkg=join(dir,'node_modules/ultrabrain-client'),sdk=join(layout==='hoisted'?dir:pkg,'node_modules/@modelcontextprotocol/sdk');
 mkdirSync(join(pkg,'dist'),{recursive:true});mkdirSync(sdk,{recursive:true});
 writeFileSync(join(sdk,'package.json'),JSON.stringify({name:'@modelcontextprotocol/sdk',exports:{'./client/index.js':'./client.cjs'}}));
 writeFileSync(join(sdk,'client.cjs'),"exports.Client=class{async callTool(){return 'synthetic transport';}};");
 writeFileSync(join(pkg,'dist/memory-review-cli.cjs'),"const {Client}=require('@modelcontextprotocol/sdk/client/index.js');process.send=()=>{console.log('BARRIER');queueMicrotask(()=>process.emit('message',{}));};process.disconnect=()=>{};new Client().callTool({name:'ultra_memory_read'}).then(console.log);");
 const preload=join(dir,'preload.cjs');writeFileSync(preload,memoryReadBarrierPreload(pkg));
 const out=spawnSync(process.execPath,['--require',preload,join(pkg,'dist/memory-review-cli.cjs')],{encoding:'utf8',timeout:5000});
 assert.ifError(out.error);assert.equal(out.status,0,out.stderr);assert.equal(out.stdout,'BARRIER\nsynthetic transport\n');
 if(layout==='hoisted'){
  writeFileSync(preload,`require(${JSON.stringify(join(pkg,'node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js'))});`);
  const old=spawnSync(process.execPath,['--require',preload,'-e',''],{encoding:'utf8',timeout:5000});
  assert.equal(old.status,1);assert.match(old.stderr,/MODULE_NOT_FOUND/);
 }
});
