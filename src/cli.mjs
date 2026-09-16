#!/usr/bin/env bun
import { spawnSync, spawn } from 'node:child_process';
import {deploymentProfile} from './enterprise-policy.mjs';
import { ROOT, prepareEnvironment, connect } from './runtime.mjs';
const args = process.argv.slice(2);
const [command, ...rest] = args;
try {
  if (!command || ['help','--help','-h'].includes(command)) {
    console.log(`ultrabrain 0.14.0-alpha.1 — Linux / managed PostgreSQL
  preflight --mode install|runtime            Offline, read-only installation checks
  personal-services render|verify             Inactive personal console/timer units
  recovery create|verify|stage|restore-database   Private recovery set; never auto-activate
  db init|start|stop|status|backup|restore-new   Manage local PostgreSQL
  db activate-runtime                        Switch a stopped cluster to reviewed same-major binaries
  db vector-plan|vector-upgrade|vector-recover   Review/upgrade pinned vector SQL objects
  personal-model-config --from-chat-model --revision ID   Enable personal candidate extraction
  personal-ui [--source SOURCE --port 3132]   Local-owner browser console (token protected)
  enterprise configure|status|audit          Host-only source admission policy and audit
  verify --project ID --task ID -- command    Host-only execution evidence (no remote executor)
  summary-config --from-chat-model --revision ID   Explicitly enable source summaries
  compat                                     Check native catalog compatibility without a database
  health                                     Read-only managed-runtime diagnostics (JSON)
  migrate                                    Apply native and ultrabrain schemas
  mcp                                        Native MCP stdio, all tools including ultra_*
  native <gbrain arguments>                   Full pinned upstream CLI
  upstream check|verify|prepare               Inspect or prepare reviewed upstream updates
  <other gbrain arguments>                    Forward to the native CLI

Setup: bash scripts/bootstrap-linux.sh
No arbitrary SQL MCP endpoint is added. HTTP/OAuth: native serve --help.
Lifecycle bridge: bun scripts/agent-bridge.mjs --url URL --token-file PATH --root ultra://SOURCE/ < event.json
Deferred worker: bun scripts/consolidate.mjs --url URL --token-file PATH --source SOURCE
Upstream-dependent features require their original providers/configuration.`);
  } else if (['db','upstream','summary-config','personal-model-config','recovery','preflight','personal-services'].includes(command)) {
    const script = command === 'personal-services' ? 'personal-services.py' : command === 'preflight' ? 'preflight.py' : command === 'recovery' ? 'recovery.py' : command === 'personal-model-config' ? 'configure-personal-model.py' : command === 'db' ? (['vector-plan','vector-upgrade','vector-recover'].includes(rest[0]) ? 'vector-upgrade.py' : 'postgres.py') : command === 'summary-config' ? 'configure-summary.py' : 'upstreams.py';
    const p = spawnSync('python3', [...(command === 'preflight' ? ['-B'] : []), `${ROOT}/scripts/${script}`, ...rest], { stdio: 'inherit' });
    if (p.error) throw p.error;
    process.exitCode = p.status ?? 1;
  } else if (command === 'personal-ui') {
    const {personalConsoleCLI}=await import('./personal-console.mjs');
    const {HOME}=await import('./runtime.mjs');
    await personalConsoleCLI(rest,{connect,home:HOME});
  } else if (command === 'enterprise') {
    const engine=await connect();
    try {const {enterpriseCLI}=await import('./enterprise-cli.mjs');console.log(JSON.stringify(await enterpriseCLI(rest,engine),null,2));}
    finally {await engine.disconnect();}
  } else if (command === 'verify') {
    const engine = await connect();
    try {
      const { verifyCLI } = await import('./verify-run.mjs');
      process.exitCode = await verifyCLI(rest, engine);
    } finally { await engine.disconnect(); }
  } else if (command === 'compat') {
    const {compatibilityReport} = await import('./adapters/gbrain.mjs');
    const report = await compatibilityReport();
    console.log(JSON.stringify(report,null,2));
    process.exitCode = report.compatible ? 0 : 1;
  } else if (command === 'health') {
    const { health } = await import('./health.mjs');
    const report = await health();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } else if (command === 'migrate') {
    const engine = await connect({ migrate: true });
    await engine.disconnect();
    console.log('Native and ultrabrain schemas ready.');
  } else {
    if(command==='mcp'&&rest.includes('--profile')){
      const n=rest.indexOf('--profile');
      if(rest.lastIndexOf('--profile')!==n||rest[n+1]===undefined)throw new Error('Invalid profile argument');
      process.env.ULTRABRAIN_MCP_PROFILE=deploymentProfile(rest[n+1]);rest.splice(n,2);
    }
    const profile=deploymentProfile(process.env.ULTRABRAIN_MCP_PROFILE);
    const forwarded = command === 'native' ? rest : command === 'mcp' ? ['serve','--surface','full', ...rest] : args;
    if (['self-update','self-upgrade','update','upgrade','init','reinit-pglite','pglite-repair','post-upgrade'].includes(forwarded[0])) {
      throw new Error('Use managed db init + migrate, or upstream prepare. Native self-update/init could bypass pins or replace PostgreSQL with PGLite.');
    }
    if(profile==='governed'&&forwarded[0]==='serve'){
      if(forwarded.some(x=>['--log-full-params','--enable-dcr-insecure'].includes(x)))throw new Error('Sensitive logging and insecure registration are disabled in governed mode');
      process.env.GBRAIN_SWEEP='0';
      if(!forwarded.includes('--http'))throw new Error('Governed profile requires authenticated HTTP');
      const bind=forwarded.indexOf('--bind');
      if(bind>=0&&(forwarded.lastIndexOf('--bind')!==bind||forwarded[bind+1]!=='127.0.0.1'))throw new Error('Governed service must bind loopback behind a restricted TLS proxy');
      if(forwarded.some(x=>x.startsWith('--bind=')||x.startsWith('--profile=')))throw new Error('Use explicit supported flags');
      if(bind<0)forwarded.push('--bind','127.0.0.1');
    }
    prepareEnvironment();
    const child = spawn(process.execPath, ['--preload', `${ROOT}/src/preload.mjs`,
      `${ROOT}/vendor/gbrain/src/cli.ts`, ...forwarded], { stdio: 'inherit', env: process.env });
    const forwardTerm = () => child.kill('SIGTERM');
    const forwardInt = () => child.kill('SIGINT');
    process.on('SIGTERM', forwardTerm); process.on('SIGINT', forwardInt);
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)));
      });
    } finally {
      process.off('SIGTERM', forwardTerm); process.off('SIGINT', forwardInt);
    }
  }
} catch (error) {
  console.error(`ultrabrain: ${error.code ?? error.name ?? 'error'}; ${['ENOENT','EACCES'].includes(error.code) ? 'Run db init and check private file permissions.' : 'Command failed; verify setup, configuration and upstream compatibility.'}`);
  if (process.env.ULTRABRAIN_DEBUG === '1') console.error(String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[database-url-redacted]'));
  process.exitCode = 1;
}
