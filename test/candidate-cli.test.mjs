import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {candidateMain,candidateArgs} from '../scripts/candidate-check.mjs';
import {head,base} from './helpers/candidate-fixture.mjs';
const args=['--pr','29','--head',head,'--base',base,'--reviewer-id','2'];
for(const [state,code]of [['metadata_requirements_met',0],['blocked',2]])test('CLI: machine exit semantics '+state,async()=>{
  let out='';const result=await candidateMain(args,{write:s=>out+=s,collect:async p=>{assert.equal(p.pr,29);return {status:state,merge_authorized:false};}});
  assert.equal(result,code);assert.equal(out.split('\n').length,2);assert.equal(JSON.parse(out).merge_authorized,false);
});
for(const bad of [[],['--pr','1'],[...args,'--head',head],[...args,'--unknown','value'],[...args,'--reviewer-id','2'],['--help','extra']])
  test('CLI: rejects malformed/duplicate arguments',async()=>{
    let out='';assert.equal(await candidateMain(bad,{write:s=>out+=s,collect:async()=>assert.fail('No IO')}),1);
    assert.equal(JSON.parse(out).error,'invalid_params');
  });
test('CLI: sanitized failure never prints remote diagnostics or token',async()=>{
  let out='';assert.equal(await candidateMain(args,{write:s=>out+=s,token:'PRIVATE_TOKEN',collect:async()=>{throw Error('PRIVATE_DIAGNOSTIC');}}),1);
  assert.ok(!out.includes('PRIVATE'));assert.equal(JSON.parse(out).merge_authorized,false);
});
test('CLI: real subprocess --help exits without data access',()=>{
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/candidate-check.mjs',import.meta.url)),'--help'],{encoding:'utf8',timeout:5000});
  assert.ifError(r.error);assert.equal(r.status,0);assert.match(r.stdout,/NOT merge approval/);assert.equal(r.stderr,'');
});
