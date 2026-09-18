/** Private, read-only process/database proof. The console credential is never transmitted.
 * A proof's timestamp must be within ten seconds past or two seconds future. It
 * cannot authenticate /api/call, a different invocation, or a different origin.
 */
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {requireThat,sourceId} from './core.mjs';
import {objectFields} from './personal-memory.mjs';

const REQUEST_DOMAIN='ultrabrain-personal-ready-request-v1\n';
const RESPONSE_DOMAIN='ultrabrain-personal-ready-response-v1\n';
const HEX64=/^[a-f0-9]{64}$/;
const INVOCATION=/^[a-f0-9]{32}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REQUEST_FIELDS=['format','nonce','origin','invocation_id','issued_at','proof'];
const validInvocation=value=>typeof value==='string'&&INVOCATION.test(value)&&value!=='0'.repeat(32);
const positiveInteger=value=>Number.isSafeInteger(value)&&value>0;
const canonicalRequest=value=>JSON.stringify([1,value.nonce,value.origin,value.invocation_id,value.issued_at]);
const mac=(key,domain,text)=>createHmac('sha256',key).update(domain+text,'ascii').digest('hex');

/** Internal module API. The invocation is captured when the console starts, never from HTTP. */
export function createPersonalReadiness({engine,source,token,invocationId}) {
  sourceId(source);
  requireThat(typeof token==='string'&&HEX64.test(token),'invalid_token_file','A full console token is required');
  const key=Buffer.from(token,'hex');
  return Object.freeze({
    authenticate(body,origin) {
      objectFields(body,REQUEST_FIELDS);
      requireThat(Object.keys(body).length===REQUEST_FIELDS.length&&body.format===1&&
        typeof body.nonce==='string'&&HEX64.test(body.nonce)&&typeof body.proof==='string'&&HEX64.test(body.proof)&&
        typeof body.origin==='string'&&body.origin.length<=64&&typeof body.invocation_id==='string'&&INVOCATION.test(body.invocation_id)&&
        Number.isSafeInteger(body.issued_at),'invalid_params','Invalid readiness request');
      requireThat(validInvocation(invocationId),'readiness_unavailable','Readiness is unavailable');
      const now=Math.floor(Date.now()/1000),canonical=canonicalRequest(body);
      requireThat(timingSafeEqual(Buffer.from(body.proof,'hex'),Buffer.from(mac(key,REQUEST_DOMAIN,canonical),'hex'))&&
        body.origin===origin&&body.invocation_id===invocationId&&body.issued_at>=now-10&&body.issued_at<=now+2,
        'unauthorized','Readiness authentication required');
      return Object.freeze({nonce:body.nonce,request_sha256:createHash('sha256').update(canonical,'ascii').digest('hex')});
    },
    async query(request,origin) {
      // A separate read-only transaction keeps the timeouts local to this probe. No
      // migration, memory contents, model access, or application writes occur here.
      const rows=await engine.transaction(async tx=>{
        await tx.executeRaw('SET TRANSACTION READ ONLY');
        await tx.executeRaw("SET LOCAL statement_timeout='2s'");
        await tx.executeRaw("SET LOCAL lock_timeout='1s'");
        return tx.executeRaw(`SELECT
          EXISTS(SELECT 1 FROM public.sources WHERE id=$1) AS source_exists,
          (SELECT instance_id::text FROM ultrabrain.instance_identity WHERE singleton) AS instance_id,
          pg_catalog.pg_backend_pid() AS backend_pid,
          pg_catalog.inet_server_port() AS database_port,
          pg_catalog.current_database() AS database_name,
          current_user AS database_user,
          pg_catalog.inet_server_addr()::text AS database_address,
          session_user AS database_session_user,
          pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.pg_postmaster_start_time()))::bigint::text AS postmaster_started,
          pg_catalog.current_schema()='public' AND
            pg_catalog.to_regclass('ultrabrain.personal_memories') IS NOT NULL AND
            pg_catalog.to_regclass('ultrabrain.personal_events') IS NOT NULL AND
            pg_catalog.to_regclass('ultrabrain.agent_registry') IS NOT NULL AND
            pg_catalog.to_regclass('ultrabrain.personal_consolidations') IS NOT NULL AND
            pg_catalog.to_regclass('ultrabrain.personal_documents') IS NOT NULL AND
            pg_catalog.to_regclass('ultrabrain.personal_document_fragments') IS NOT NULL AND
            EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='ultrabrain' AND
              table_name='personal_memories' AND column_name='actor_key') AS schema_ready`,[source]);
      });
      const row=Array.isArray(rows)&&rows.length===1?rows[0]:undefined;
      // The SQL returns the fixed timestamp as decimal text. Normalize this field
      // without allowing a lossy integer in the signed response.
      const postmasterStarted=typeof row?.postmaster_started==='string'&&/^[1-9][0-9]{0,15}$/.test(row.postmaster_started)
        ?Number(row.postmaster_started):row?.postmaster_started;
      requireThat(row&&row.source_exists===true&&row.schema_ready===true&&
        typeof row.instance_id==='string'&&UUID.test(row.instance_id)&&row.instance_id!=='00000000-0000-0000-0000-000000000000'&&
        positiveInteger(row.backend_pid)&&row.backend_pid<=2147483647&&
        positiveInteger(row.database_port)&&row.database_port<=65535&&
        row.database_name==='ultrabrain'&&row.database_user==='ultrabrain'&&
        row.database_address==='127.0.0.1'&&row.database_session_user==='ultrabrain'&&positiveInteger(postmasterStarted),
        'readiness_unavailable','Readiness is unavailable');
      const result={format:1,request_sha256:request.request_sha256,nonce:request.nonce,origin,source_id:source,
        invocation_id:invocationId,pid:process.pid,instance_id:row.instance_id,backend_pid:row.backend_pid,
        database_port:row.database_port,database_name:row.database_name,database_user:row.database_user,
        database_address:row.database_address,database_session_user:row.database_session_user,postmaster_started:postmasterStarted};
      const canonical=JSON.stringify([1,result.request_sha256,result.nonce,result.origin,result.source_id,result.invocation_id,
        result.pid,result.instance_id,result.backend_pid,result.database_port,result.database_name,result.database_user,
        result.database_address,result.database_session_user,result.postmaster_started]);
      result.proof=mac(key,RESPONSE_DOMAIN,canonical);
      return result;
    }
  });
}
