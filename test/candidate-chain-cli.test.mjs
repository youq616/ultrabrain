import test from 'node:test';import assert from 'node:assert/strict';
import {Readable,PassThrough} from 'node:stream';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {candidateChainMain,candidateChainInput} from '../scripts/candidate-chain-check.mjs';
import {candidateReader} from '../src/candidate-github.mjs';
import {chainSelection,shas} from './helpers/candidate-chain-fixture.mjs';
const from=v=>Readable.from([typeof v==='string'||v instanceof Uint8Array?v:JSON.stringify(v)]);
const script=fileURLToPath(new URL('../scripts/candidate-chain-check.mjs',import.meta.url));
for(const [status,code]of [['metadata_requirements_met',0],['blocked',2]])test('chain CLI: one JSON result and correct exit '+status,async()=>{
 let output='',calls=0;
 const rc=await candidateChainMain([],{input:from(chainSelection()),write:t=>output+=t,collect:async p=>{calls++;assert.equal(p.candidates.length,2);return {status,merge_authorized:false};}});
 assert.equal(rc,code);assert.equal(calls,1);assert.equal(output.trim().split('\n').length,1);assert.equal(JSON.parse(output).merge_authorized,false);
});
for(const [raw,error]of [['{}','invalid_params'],['not json','candidate_input_invalid'],['x'.repeat(16385),'candidate_input_too_large'],
 ['\ufeff{}','candidate_input_invalid'],[new Uint8Array([0xff]),'candidate_input_invalid'],
 [JSON.stringify(chainSelection()).replace('"reviewer_ids":[2,3]','"reviewer_ids":[2,3],"reviewer_\\u0069ds":[]'),'candidate_input_invalid']])
 test('chain CLI: bounded/invalid selection is refused before network '+error,async()=>{
  let output='';const rc=await candidateChainMain([],{input:from(raw),write:t=>output+=t,collect:async()=>assert.fail('No IO')});
  assert.equal(rc,1);assert.equal(JSON.parse(output).error,error);assert.equal(JSON.parse(output).nodes,undefined);
 });
test('chain CLI: no file path/URL/options accepted as a replacement for stdin',async()=>{
 let out='';assert.equal(await candidateChainMain(['--url','https://example.invalid'],{input:from(chainSelection()),write:s=>out+=s,collect:async()=>assert.fail('No IO')}),1);
 assert.equal(JSON.parse(out).error,'invalid_params');
});
test('chain CLI: stream split across multibyte character boundary is validated after join',async()=>{
 // The forbidden field value exercises UTF-8 decoding but still fails strict selection.
 const b=Buffer.from(JSON.stringify({...chainSelection(),extra:'中文'}));
 await assert.rejects(candidateChainInput(Readable.from(Array.from(b,x=>Buffer.from([x])))),{code:'invalid_params'});
});
test('chain CLI: cancellation during stdin releases wait and produces no partial report',async()=>{
 const c=new AbortController(),input=new PassThrough();let output='';
 const task=candidateChainMain([],{input,signal:c.signal,write:t=>output+=t,collect:async()=>assert.fail('No IO')});
 input.write('{');c.abort();assert.equal(await task,1);assert.equal(JSON.parse(output).error,'aborted');assert.equal(input.destroyed,true);
});
test('chain CLI: cancellation immediately before output suppresses completed report',async()=>{
 const c=new AbortController();let output='';
 const rc=await candidateChainMain([],{input:from(chainSelection()),signal:c.signal,write:t=>output+=t,collect:async()=>{
  c.abort();return {status:'metadata_requirements_met',merge_authorized:false};}});
 assert.equal(rc,1);assert.equal(JSON.parse(output).error,'aborted');assert.equal(JSON.parse(output).status,undefined);
});
test('chain CLI: remote exception never prints raw tokens/paths',async()=>{
 let output='';assert.equal(await candidateChainMain([],{input:from(chainSelection()),token:'PRIVATE_TOKEN',write:t=>output+=t,
 collect:async()=>{throw Error('PRIVATE_TOKEN /private/path');}}),1);assert.ok(!output.includes('PRIVATE'));assert.equal(JSON.parse(output).merge_authorized,false);
});
test('chain CLI: real help subprocess performs no selected-file access',()=>{
 const r=spawnSync(process.execPath,[script,'--help'],{encoding:'utf8',timeout:5000});assert.ifError(r.error);assert.equal(r.status,0);
 assert.match(r.stdout,/NOT approval of the anchor/);assert.equal(r.stderr,'');
});
test('chain CLI: real invalid stdin subprocess returns one safe JSON failure',()=>{
 const r=spawnSync(process.execPath,[script],{input:'{"PRIVATE_INPUT":',encoding:'utf8',timeout:5000});assert.ifError(r.error);
 assert.equal(r.status,1);assert.equal(r.stderr,'');assert.equal(JSON.parse(r.stdout).error,'candidate_input_invalid');assert.ok(!r.stdout.includes('PRIVATE_INPUT'));
});
const compare='/repos/youq616/ultrabrain/compare/'+shas[0]+'...'+shas[1]+'?per_page=1&page=2';
test('chain reader: old single-PR reader cannot access comparison by default',async()=>{
 let calls=0;await assert.rejects(candidateReader({fetchImpl:async()=>{calls++;return new Response('{}');}})(compare),{code:'invalid_params'});
 assert.equal(calls,0);
});
test('chain reader: explicit comparison permission allows only metadata page via fixed GET host',async()=>{
 let seen;const read=candidateReader({allowCompare:true,token:'SYNTHETIC_TOKEN',fetchImpl:async(url,options)=>{seen={url,options};return new Response('{}');}});
 await read(compare);assert.equal(seen.url,'https://api.github.com'+compare);assert.equal(seen.options.method,'GET');assert.equal(seen.options.redirect,'error');
 assert.equal(seen.options.headers.Authorization,'Bearer SYNTHETIC_TOKEN');
});
for(const p of [compare.replace('page=2','page=1'),compare.replace('per_page=1','per_page=100'),compare.replace(shas[0],'main'),
 compare+'&extra=1',compare.replace('...','..'),compare.replace('youq616/ultrabrain','other/repo'),compare+'#secret',compare+'/../merge'])
 test('chain reader: comparison opt-in does not permit altered route '+p,async()=>{
  let n=0;await assert.rejects(candidateReader({allowCompare:true,fetchImpl:async()=>{n++;return new Response('{}');}})(p),{code:'invalid_params'});assert.equal(n,0);
 });
