/** Read-only product diagnostics: no credentials, memory contents or provider calls. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, HOME, connect, loadNative } from './runtime.mjs';
export async function health() {
  const pins=JSON.parse(readFileSync(join(ROOT,'upstreams.lock.json'),'utf8')).projects;
  const runtime=JSON.parse(readFileSync(join(HOME,'postgres/runtime.json'),'utf8'));
  const engine=await connect();
  try {
    const [role]=await engine.executeRaw(`SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`);
    const [server]=await engine.executeRaw(`SELECT current_setting('server_version') AS version,
      current_setting('listen_addresses') AS listen_addresses`);
    const extensions=await engine.executeRaw('SELECT extname,extversion FROM pg_extension ORDER BY extname');
    const [schema]=await engine.executeRaw("SELECT value FROM config WHERE key='version'");
    const [receipts]=await engine.executeRaw("SELECT to_regclass('ultrabrain.session_receipts') IS NOT NULL AS available");
    const {operations}=await loadNative('src/core/operations.ts');
    const checks={non_superuser:role.rolsuper===false,no_role_or_database_creation:!role.rolcreatedb&&!role.rolcreaterole,
      database_loopback_only:server.listen_addresses==='127.0.0.1',
      postgres_version:server.version.split(' ')[0]===runtime.version,
      pgvector_version:extensions.some(x=>x.extname==='vector'&&x.extversion===pins.pgvector.version),
      native_schema_present:Number(schema?.value)>0,session_schema_present:receipts.available===true,
      custom_tools_registered:operations.filter(x=>x.name.startsWith('ultra_')).length===6};
    return {ok:Object.values(checks).every(Boolean),checks,database:{engine:'native-postgresql',
      version:server.version,bypassrls:role.rolbypassrls,schema_version:Number(schema?.value)},
      runtime,extensions,registered_operations:operations.length,
      client_isolation:'native operation-layer authorization; not PostgreSQL per-client RLS',
      model_calls:'not performed; use native doctor for provider configuration diagnostics'};
  } finally {await engine.disconnect();}
}
