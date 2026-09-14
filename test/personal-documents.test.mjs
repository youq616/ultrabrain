/** Pure personal-document contract tests: no database, no MCP, no model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,mkdtempSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {
  documentLabel,documentFormat,decodeDocumentContent,documentContent,importDocumentRequest,
  fragmentRanges,documentFragment,PERSONAL_DOCUMENT_MAX_BYTES,PERSONAL_DOCUMENT_FORMATS
} from '../src/personal-documents.mjs';
import {readLocalDocument,documentImportRequest} from '../src/client-document.mjs';
const rejects=(fn,code)=>assert.rejects(fn,{code});
const b64=bytes=>Buffer.from(bytes).toString('base64');
const SHA=bytes=>createHash('sha256').update(bytes).digest('hex');
test('labels are plain names, never paths, drives or control characters',()=>{
  assert.equal(documentLabel('notes (2026).txt'),'notes (2026).txt');
  assert.equal(documentLabel('我的笔记.md'),'我的笔记.md');
  for(const bad of ['../secrets.txt','..\\secrets.txt','a/b.md','a\\b.log','C:\\x\\y.txt','a:b.txt','x?y.md','.','..',
    'bad\u0000.txt','bad\n.txt','bad\x7f.txt','x'.repeat(300)])assert.throws(()=>documentLabel(bad),{code:'invalid_label'});
});
test('first-batch formats only; extension is derived, not trusted',()=>{
  for(const good of ['a.txt','b.MD','c.Json','d.csv','e.LOG'])assert.ok(PERSONAL_DOCUMENT_FORMATS.includes(documentFormat(good)));
  for(const bad of ['a.pdf','b.png','c.docx','noext','d.txtx'])assert.throws(()=>documentFormat(bad),{code:'unsupported_format'});
});
test('strict base64 only: padding, alphabet and canonical round-trip enforced',()=>{
  assert.deepEqual(decodeDocumentContent(b64('hello')),Buffer.from('hello'));
  for(const bad of ['aGVsbG8','!!!!','aGVsbG8= ','aGVs bG8=','-_8AAA',''])assert.throws(()=>decodeDocumentContent(bad),{code:'invalid_params'});
});
test('strict UTF-8: overlong, surrogate, truncated and UTF-16 BOM sequences are rejected whole',()=>{
  const ok=Buffer.concat([Buffer.from([0xEF,0xBB,0xBF]),Buffer.from('line1\r\n偏好与否定词：不要 Docker\r\n','utf8')]);
  const content=documentContent(ok);
  assert.equal(content.has_bom,true);
  assert.equal(Buffer.from(content.text,'utf8').equals(ok),true); // BOM, CRLF and negations survive byte-exactly.
  assert.equal(content.content_sha256,SHA(ok));
  for(const bad of [[0xC0,0xAF],[0xED,0xA0,0x80],[0xE4,0xBD],[0xFF,0xFE,0x41,0x00],[0xF5,0x80,0x80,0x80]])
    assert.throws(()=>documentContent(Buffer.from(bad)),{code:'invalid_utf8'});
});
test('file size limit rejects whole files, never truncates',()=>{
  const exact=Buffer.alloc(PERSONAL_DOCUMENT_MAX_BYTES,0x61);exact.write('A',0);
  assert.ok(documentContent(decodeDocumentContent(b64(exact))));
  const over=Buffer.alloc(PERSONAL_DOCUMENT_MAX_BYTES+1,0x61);
  assert.throws(()=>decodeDocumentContent(b64(over)),{code:'file_too_large'});
  assert.throws(()=>documentContent(over),{code:'file_too_large'});
  // Very large payloads report the documented size code, not a generic parameter error.
  assert.throws(()=>decodeDocumentContent('a'.repeat(200001)),{code:'file_too_large'});
});
test('fingerprint mismatch between claimed digest and submitted bytes is rejected',()=>{
  const bytes=Buffer.from('regular notes\n','utf8');
  assert.throws(()=>importDocumentRequest({event_id:'e1',agent_id:'ag',label:'n.txt',consent:true,
    content_base64:b64(bytes),content_sha256:'0'.repeat(64)}),{code:'fingerprint_mismatch'});
  const good=importDocumentRequest({event_id:'e1',agent_id:'ag',label:'n.txt',consent:true,
    content_base64:b64(bytes),content_sha256:SHA(bytes)});
  assert.equal(good.byte_size,bytes.length);assert.equal(good.format,'txt');assert.equal(good.has_bom,false);
});
test('explicit consent is mandatory for import requests',()=>{
  const bytes=Buffer.from('x','utf8');
  assert.throws(()=>importDocumentRequest({event_id:'e1',agent_id:'ag',label:'n.txt',consent:false,
    content_base64:b64(bytes),content_sha256:SHA(bytes)}),{code:'capture_disabled'});
  assert.throws(()=>importDocumentRequest({event_id:'e1',agent_id:'ag',label:'n.txt',
    content_base64:b64(bytes),content_sha256:SHA(bytes)}),{code:'capture_disabled'});
});
test('fragment ranges: bounded, non-overlapping, inside the file and UTF-8 aligned',()=>{
  const bytes=Buffer.from('αβγδε','utf8'); // 2-byte code points
  const ranges=fragmentRanges([{byte_start:2,byte_length:4},{byte_start:0,byte_length:2}],bytes.length);
  assert.deepEqual(ranges,[{byte_start:0,byte_end:2},{byte_start:2,byte_end:6}]);
  for(const [bad,size] of [
    [[{byte_start:0,byte_length:0}],bytes.length],[[{byte_start:0,byte_length:bytes.length+1}],bytes.length],
    [[{byte_start:0,byte_length:2},{byte_start:1,byte_length:2}],bytes.length],[[{byte_start:-1,byte_length:2}],bytes.length],
    [[{byte_start:0,byte_length:32769}],PERSONAL_DOCUMENT_MAX_BYTES],
    [Array.from({length:17},()=>({byte_start:0,byte_length:1})),PERSONAL_DOCUMENT_MAX_BYTES]])
    assert.throws(()=>fragmentRanges(bad,size),{code:'invalid_params'});
  assert.throws(()=>documentFragment(bytes,{byte_start:1,byte_end:3}),{code:'invalid_utf8'}); // splits a code point
  const fragment=documentFragment(bytes,{byte_start:2,byte_end:6});
  assert.equal(fragment.text,'βγ');assert.equal(fragment.fragment_sha256,SHA(bytes.subarray(2,6)));
});
test('readLocalDocument reads one explicit regular file and refuses symlinks',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ubdoc-'));
  try {
    const real=join(dir,'real.txt');writeFileSync(real,'explicit content\n');
    const picked=readLocalDocument(real);
    assert.equal(picked.label,'real.txt');assert.equal(picked.byte_size,17);
    assert.equal(picked.content_base64,b64(Buffer.from('explicit content\n')));
    let symlinkMade=false;
    try{symlinkSync(real,join(dir,'link.txt'));symlinkMade=true;}catch{ /* Windows without symlink privilege: contract still verified on Linux CI */ }
    if(symlinkMade)assert.throws(()=>readLocalDocument(join(dir,'link.txt')),{code:'invalid_path'});
    writeFileSync(join(dir,'big.log'),Buffer.alloc(PERSONAL_DOCUMENT_MAX_BYTES+1,0x62));
    assert.throws(()=>readLocalDocument(join(dir,'big.log')),{code:'file_too_large'});
    writeFileSync(join(dir,'bad.txt'),Buffer.from([0xC0,0xAF]));
    assert.throws(()=>readLocalDocument(join(dir,'bad.txt')),{code:'invalid_utf8'});
    writeFileSync(join(dir,'image.png'),Buffer.from('png'));
    assert.throws(()=>readLocalDocument(join(dir,'image.png')),{code:'unsupported_format'});
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('client import requests pin the project to the trusted profile and freeze consent',async()=>{
  const bytes=Buffer.from('k','utf8'),sha=await SHA(bytes);
  const profile={projectId:'proj-a',allowCapture:false};
  const request=documentImportRequest({agent_id:'ag',event_id:'e2',consent:true,label:'k.txt',
    content_base64:b64(bytes),content_sha256:sha},profile);
  assert.equal(request.project_id,'proj-a');
  assert.throws(()=>documentImportRequest({agent_id:'ag',event_id:'e2',consent:true,label:'k.txt',
    content_base64:b64(bytes),content_sha256:sha,project_id:'other'},profile),{code:'scope_denied'});
  assert.throws(()=>documentImportRequest({agent_id:'ag',event_id:'e2',consent:false,label:'k.txt',
    content_base64:b64(bytes),content_sha256:sha},profile),{code:'capture_disabled'});
});
