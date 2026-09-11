import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog,compareCatalog} from '../src/adapters/gbrain.mjs';
const op=()=>({name:'read',scope:'read',params:{slug:{type:'string',required:true,description:'Prose'}},handler(){}});
test('adapter ignores documentation but not parameter or authorization changes',()=>{
  const a=op(), b=op();b.params.slug.description='new wording';
  assert.deepEqual(catalog([a]),catalog([b]));
  b.scope='write';assert.equal(compareCatalog(catalog([b]),catalog([a])).compatible,false);
  b.scope='read';b.params.slug.required=false;assert.equal(compareCatalog(catalog([b]),catalog([a])).compatible,false);
});
test('added tools require explicit review including read tools',()=>{
  const a=op();const r=compareCatalog(catalog([a,{...op(),name:'new'}]),catalog([a]));
  assert.deepEqual(r.added,['new']);assert.equal(r.compatible,false);
});
test('removed and duplicate tools fail closed',()=>{
  assert.deepEqual(compareCatalog({},catalog([op()])).removed,['read']);
  assert.throws(()=>catalog([op(),op()]),{code:'upstream_contract_changed'});
});
