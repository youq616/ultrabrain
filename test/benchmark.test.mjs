import test from 'node:test';
import assert from 'node:assert/strict';
import {benchmarkOptions,benchmarkReport} from '../src/benchmark.mjs';
const args=['--url','https://memory.example/mcp','--token-file','/private/token','--uri','ultra://test/page'];
test('load generation requires explicit consent and a bounded workload',()=>{
 assert.throws(()=>benchmarkOptions(args),{code:'load_consent_required'});
 const p=benchmarkOptions([...args,'--allow-load']);assert.equal(p.requests,100);assert.equal(p.concurrency,2);
 for(const extra of [['--requests','10001'],['--concurrency','0'],['--requests','bad'],['--url','https://other.example']])assert.throws(()=>benchmarkOptions([...args,'--allow-load',...extra]));
});
test('measurement separates success latency, rejections and attempted throughput',()=>{
 const r=benchmarkReport([{ok:true,ms:10},{ok:false,ms:1,code:'enterprise_rate_limited'},{ok:true,ms:20}],1000,{requests:3,concurrency:2});
 assert.equal(r.successful_requests,2);assert.equal(r.failed_requests,1);assert.equal(r.successful_requests_per_second,2);
 assert.equal(r.success_latency_ms.p50,10);assert.equal(r.success_latency_ms.p99,20);assert.equal(r.errors.enterprise_rate_limited,1);
});
test('total rejection cannot be mistaken for a fast successful service',()=>{
 const r=benchmarkReport([{ok:false,ms:1,code:'request_rejected'}],1,{requests:1,concurrency:1});
 assert.equal(r.success_latency_ms.p99,null);assert.equal(r.successful_requests_per_second,0);
});
