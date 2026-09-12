/** The native operation and audit-row contracts stay behind the versioned adapter. */
import {factEvidenceTools,authorizeFacts,extractWithEvidence} from './fact-evidence.mjs';
import {sha256,requireThat,UltraError} from './core.mjs';
export function factAdapter(operations,native) {
  const originals=new Map(operations.map(o=>[o.name,o]));
  for(const name of ['recall','get_page'])requireThat(originals.has(name),'upstream_contract_changed',`Missing native ${name}`);
  const store=ctx=>({source:ctx.sourceId,local:ctx.remote===false,dryRun:ctx.dryRun,
    actorKey:sha256(JSON.stringify([ctx.remote===false?'host':'remote',ctx.auth?.principal??ctx.auth?.clientId??'owner'])),
    auditSources:native.auditSources,authorize:write=>authorizeFacts(ctx,write),
    sql:(q,p)=>ctx.engine.executeRaw(q,p),transaction:fn=>ctx.engine.transaction(fn),
    async call(name,p){const op=originals.get(name);const error=native.validateParams(op,p);
      requireThat(!error,'upstream_contract_changed','Native fact parameter contract changed');return op.handler(ctx,p);},
  });
  const definitions=[
    ['ultra_fact_inspect','inspect',false,{fact_id:{type:'string',required:true}},'Read an authorized native fact fingerprint and current evidence binding. Not a truth certificate.'],
    ['ultra_fact_bind','bind',true,{fact_id:{type:'string',required:true},fact_sha256:{type:'string',required:true},evidence_uri:{type:'string',required:true},content_sha256:{type:'string',required:true},expected_revision:{type:'number',required:true},event_id:{type:'string',required:true}},'Associate one unchanged active native fact with an exact current source version. Explicit CAS; no source inference from free-text provenance.'],
    ['ultra_recall','recall',false,{uri:{type:'string',required:true},memory_policy:{type:'string',enum:['current','reviewed','history']},entity:{type:'string'},grep:{type:'string'},since:{type:'string'},session_id:{type:'string'},limit:{type:'number'},candidate_limit:{type:'number'},budget_bytes:{type:'number'}},'Recall native facts with linked-source governance. current requires a usable binding; reviewed also requires source review. history is explicit. No model calls, no automatic fact mutation.'],
  ];
  return {extract:(ctx,p,invoke)=>extractWithEvidence(store(ctx),p,invoke),register(){
    for(const [name,method,write,params,description] of definitions){
      requireThat(!operations.some(o=>o.name===name),'upstream_contract_changed',`Operation collision: ${name}`);
      operations.push({name,description,params,scope:write?'write':'read',mutating:write,area:'ultrabrain',async handler(ctx,p){
        try{return await factEvidenceTools(store(ctx))[method](p);}catch(e){if(e instanceof UltraError)throw new native.OperationError(e.code,e.message);throw e;}
      }});
    }
    return definitions.map(x=>x[0]);
  }};
}
