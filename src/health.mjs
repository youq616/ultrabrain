import {PERSONAL_TOOL_NAMES} from './personal-plugin.mjs';
import {deploymentProfile,GOVERNED_TOOLS} from './enterprise-policy.mjs';
import {META_HOOK_SHA256} from './adapters/response-metadata.mjs';
/** Read-only diagnostics: no credentials, memory contents or provider calls. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, HOME, connect, loadNative } from './runtime.mjs';
import { PROJECT_TOOL_NAMES } from './project-plugin.mjs';
export async function health() {
  const pins=JSON.parse(readFileSync(join(ROOT,'upstreams.lock.json'),'utf8')).projects;
  const runtime=JSON.parse(readFileSync(join(HOME,'postgres/runtime.json'),'utf8'));
  const engine=await connect();
  try {
    const [role]=await engine.executeRaw(`SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`);
    const [server]=await engine.executeRaw(`SELECT current_setting('server_version') AS version,current_setting('listen_addresses') AS listen_addresses`);
    const extensions=await engine.executeRaw('SELECT extname,extversion FROM pg_extension ORDER BY extname');
    const [schema]=await engine.executeRaw("SELECT value FROM config WHERE key='version'");
    const [receipts]=await engine.executeRaw("SELECT to_regclass('ultrabrain.session_receipts') IS NOT NULL AS available");
    const {operations}=await loadNative('src/core/operations.ts');
    const [projectSchema]=await engine.executeRaw("SELECT to_regclass('ultrabrain.projects') IS NOT NULL AS present,current_schema()='public' AS native_public,to_regclass('ultrabrain.pages') IS NULL AS no_shadow");
    const [deferredSchema]=await engine.executeRaw("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='ultrabrain' AND table_name='session_receipts' AND column_name='pending_payload') AS present");
    const [governance]=await engine.executeRaw("SELECT to_regclass('ultrabrain.memory_policies') IS NOT NULL AS present,(SELECT count(*) FROM ultrabrain.instance_identity WHERE singleton)=1 AS identity_ready");
    const profile=deploymentProfile(process.env.ULTRABRAIN_MCP_PROFILE);
    const [enterprise]=await engine.executeRaw("SELECT to_regclass('ultrabrain.enterprise_sources') IS NOT NULL AS policy,to_regclass('ultrabrain.enterprise_audit') IS NOT NULL AS audit");
    const [personal]=await engine.executeRaw("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='ultrabrain' AND table_name='personal_memories' AND column_name='actor_key') AS scoped,to_regclass('ultrabrain.personal_events') IS NOT NULL AS events");
    const [personalJobs]=await engine.executeRaw("SELECT to_regclass('ultrabrain.personal_consolidations') IS NOT NULL AS present");
    const checks={personal_consolidation_schema:personalJobs.present,personal_schema:personal.scoped&&personal.events,personal_tools:profile==='governed'||PERSONAL_TOOL_NAMES.every(n=>operations.some(o=>o.name===n)),enterprise_schema:enterprise.policy&&enterprise.audit,governed_catalog:profile!=='governed'||operations.length===GOVERNED_TOOLS.length&&operations.every(o=>GOVERNED_TOOLS.includes(o.name)),memory_policy_present:governance.present,instance_identity_present:governance.identity_ready,deferred_schema_present:deferredSchema.present,non_superuser:role.rolsuper===false,no_role_or_database_creation:!role.rolcreatedb&&!role.rolcreaterole,
      database_loopback_only:server.listen_addresses==='127.0.0.1',
      postgres_version:server.version.split(' ')[0]===runtime.version,
      pgvector_version:extensions.some(x=>x.extname==='vector'&&x.extversion===pins.pgvector.version),
      native_schema_present:Number(schema?.value)>0,session_schema_present:receipts.available===true,
      project_schema_present:projectSchema.present,native_schema_pinned:projectSchema.native_public&&projectSchema.no_shadow,
      custom_tools_registered:['ultra_recall','ultra_fact_inspect','ultra_fact_bind','ultra_identity','ultra_memory_inspect','ultra_memory_review','ultra_memory_supersede','ultra_memory_history','ultra_read','ultra_ls','ultra_retrieve','ultra_write','ultra_delete','ultra_commit_session','ultra_process_sessions','ultra_session_status','ultra_summarize','ultra_summary_status','ultra_summary_forget','ultra_excerpt',...PROJECT_TOOL_NAMES].every(name=>operations.some(x=>x.name===name))};
    return {ok:Object.values(checks).every(Boolean),checks,deployment_profile:profile,response_metadata_guard:META_HOOK_SHA256,production_readiness:'not certified: health checks are not HA, capacity, semantic quality or recovery-SLA evidence',database:{engine:'native-postgresql',version:server.version,bypassrls:role.rolbypassrls,schema_version:Number(schema?.value)},
      runtime,extensions,registered_operations:operations.length,
      client_isolation:'native operation-layer authorization; not PostgreSQL per-client RLS',model_calls:'not performed; use native doctor for provider configuration diagnostics'};
  } finally {await engine.disconnect();}
}
