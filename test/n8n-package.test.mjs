import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const pkg=JSON.parse(readFileSync(new URL('../packages/n8n-nodes-ultrabrain/package.json',import.meta.url),'utf8'));
const {UltrabrainApi}=require('../packages/n8n-nodes-ultrabrain/credentials/UltrabrainApi.credentials.js');
test('private package pins its protocol SDK and includes no publish or install hooks',()=>{
 assert.equal(pkg.dependencies['@modelcontextprotocol/sdk'],'1.29.0');
 assert.deepEqual(Object.keys(pkg.dependencies),['@modelcontextprotocol/sdk']);
 assert.equal(pkg.n8n.n8nNodesApiVersion,1);assert.ok(!pkg.scripts?.postinstall);assert.ok(!pkg.scripts?.preinstall);
 assert.ok(pkg.files.includes('dist'));
});
test('credentials are separate with capture ceilings disabled and token masked',()=>{
 const c=new UltrabrainApi();assert.equal(c.name,'ultrabrainApi');
 assert.equal(c.properties.find(x=>x.name==='token').typeOptions.password,true);
 for(const k of ['allowCapture','allowSharedCapture'])assert.equal(c.properties.find(x=>x.name===k).default,false);
});
for(const f of ['context.private.json','capture.private.json'])test('example workflow is inactive, credential-free and does not retain full executions: '+f,()=>{
 const w=JSON.parse(readFileSync(new URL('../examples/n8n/'+f,import.meta.url),'utf8'));
 assert.equal(w.active,false);assert.equal(w.settings.saveDataSuccessExecution,'none');
 assert.equal(w.settings.saveDataErrorExecution,'none');assert.equal(w.settings.saveManualExecutions,false);
 assert.ok(w.nodes.every(n=>!n.credentials));const node=w.nodes.find(n=>n.type==='CUSTOM.ultrabrain');assert.ok(node);
 if(f.startsWith('capture'))assert.equal(node.parameters.captureConsent,false);
});
test('client memory selection does not import database governance',()=>{
 const code=readFileSync(new URL('../src/memory-selection.mjs',import.meta.url),'utf8');
 assert.ok(!code.includes('projects.mjs'));assert.ok(!code.includes('executeRaw'));
});
