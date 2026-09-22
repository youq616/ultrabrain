/** Actual local file IO; no SDK, server or database. */
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync,mkdirSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {inspectClientSnapshots,snapshotFileRequest} from '../src/client-snapshot-files.mjs';
import {encoded,envelope,row,uuid,hash} from './helpers/snapshot-audit-fixture.mjs';
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'ub-offline-snapshot-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'selected snapshot 中文.json');writeFileSync(path,encoded());
  return {dir,path,request:{operation:'inspect',consent:true,files:[{path}]}};
}
test('snapshot files: metadata inspection leaves input bytes/mtime unchanged and never echoes path',async t=>{
  const f=fixture(t),before=readFileSync(f.path),stat=statSync(f.path);const r=await inspectClientSnapshots(f.request);
  assert.equal(r.files[0].file_sha256,hash(before));assert.ok(!JSON.stringify(r).includes(f.dir));
  assert.deepEqual(readFileSync(f.path),before);assert.equal(statSync(f.path).mtimeMs,stat.mtimeMs);
});
test('snapshot files: compare and pinned exact text use real selected files',async t=>{
  const f=fixture(t),other=join(f.dir,'next.json');writeFileSync(other,encoded(envelope([row(2)])));
  const r=await inspectClientSnapshots({...f.request,operation:'compare',files:[{path:f.path},{path:other}]});
  assert.deepEqual(r.result.counts,{left_only:1,right_only:1,changed:0,unchanged:0});
  const one=await inspectClientSnapshots({...f.request,operation:'record',memory_id:uuid(1),include_text:true,
    files:[{path:f.path,expected_sha256:hash(readFileSync(f.path))}]});
  assert.equal(one.result.text.content,row(1).content);assert.equal(one.files[0].expected_hash_verified,true);
});
for(const path of ['relative.json','https://example.invalid/snapshot.json','file:///tmp/export.json',
  '//network/share/file.json','\\\\host\\share\\file.json','/tmp/../secret','/tmp/./secret','/tmp/\0secret',42])
  test('snapshot files: nonlocal/ambiguous path rejected before filesystem '+String(path),()=>{
    assert.throws(()=>snapshotFileRequest({operation:'inspect',consent:true,files:[{path}]}));
  });
test('snapshot files: invalid second selection is rejected before reading the first',t=>{
  const f=fixture(t);
  for(const files of [[{path:f.path},{path:'relative'}],[{path:f.path},{path:f.path,extra:true}],
    [{path:f.path},{path:f.path,expected_sha256:'bad'}],Object.assign(new Array(2),{0:{path:f.path}})])
    assert.throws(()=>snapshotFileRequest({...f.request,operation:'compare',files}));
});
test('snapshot files: requests and disclosure are copied before IO',async t=>{
  const f=fixture(t);const q={...f.request,operation:'record',memory_id:uuid(1)};
  const work=inspectClientSnapshots(q);q.files[0].path=join(f.dir,'missing');q.include_text=true;q.memory_id=uuid(8);
  const r=await work;assert.equal(r.result.memory.id,uuid(1));assert.equal(r.result.text,undefined);
});
test('snapshot files: missing/directory/empty/oversize reject without raw path details',async t=>{
  const f=fixture(t);const empty=join(f.dir,'empty'),large=join(f.dir,'large');
  writeFileSync(empty,'');writeFileSync(large,Buffer.alloc(16777217));
  for(const [path,code]of [[join(f.dir,'PRIVATE_MISSING'),'snapshot_file_unavailable'],[f.dir,'snapshot_path_invalid'],
    [empty,'snapshot_file_size'],[large,'snapshot_file_size']]){
    await assert.rejects(inspectClientSnapshots({...f.request,files:[{path}]}),e=>e.code===code&&!e.message.includes(f.dir)&&!e.message.includes('PRIVATE'));
  }
});
test('snapshot files: linked selections are refused (Windows junction or POSIX file link)',async t=>{
  const f=fixture(t);let path;
  if(process.platform==='win32'){
    const link=join(f.dir,'junction');symlinkSync(f.dir,link,'junction');path=join(link,'selected snapshot 中文.json');
  }else{path=join(f.dir,'link.json');symlinkSync(f.path,path);}
  await assert.rejects(inspectClientSnapshots({...f.request,files:[{path}]}),{code:'snapshot_path_invalid'});
});
test('snapshot files: linked ancestor is refused without following its contents',async t=>{
  const f=fixture(t),target=join(f.dir,'target'),link=join(f.dir,'linked');mkdirSync(target);
  writeFileSync(join(target,'file.json'),encoded());symlinkSync(target,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(inspectClientSnapshots({...f.request,files:[{path:join(link,'file.json')}]}),{code:'snapshot_path_invalid'});
});
test('snapshot files: consent/authority/cancellation failures precede missing-file diagnostics',async t=>{
  const f=fixture(t);f.request.files[0].path=join(f.dir,'missing');
  await assert.rejects(inspectClientSnapshots({...f.request,consent:false}),{code:'snapshot_consent_required'});
  await assert.rejects(inspectClientSnapshots(f.request,{authorize:()=>false}),{code:'client_authorization_revoked'});
  const c=new AbortController();c.abort();await assert.rejects(inspectClientSnapshots(f.request,{signal:c.signal}),{code:'aborted'});
});
test('snapshot files: invalid page options fail before any selected file access',async t=>{
  const f=fixture(t);f.request.files[0].path=join(f.dir,'missing');
  await assert.rejects(inspectClientSnapshots({...f.request,operation:'page',options:{offset:1}}),{code:'snapshot_query_invalid'});
});
test('snapshot files: coercible operation cannot authorize filesystem reads',t=>{
  const f=fixture(t);
  assert.throws(()=>snapshotFileRequest({...f.request,operation:['inspect']}),{code:'invalid_params'});
});
