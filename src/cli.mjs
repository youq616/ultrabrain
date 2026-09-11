#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { ROOT, prepareEnvironment, installPlugin, connect, loadNative } from './runtime.mjs';
const args = process.argv.slice(2);
const [command, ...rest] = args;
try {
  if (!command || ['help','--help','-h'].includes(command)) {
    console.log(`ultrabrain 0.1.0 — Linux / managed PostgreSQL
  db init|start|stop|status|backup|restore-new   Manage local PostgreSQL
  migrate                                    Apply native and ultrabrain schemas
  mcp                                        Native MCP stdio, all tools including ultra_*
  native <gbrain arguments>                   Full pinned upstream CLI
  upstream check|verify|prepare               Inspect or prepare reviewed upstream updates
  <other gbrain arguments>                    Forward to the native CLI

Setup: bash scripts/bootstrap-linux.sh
No arbitrary SQL MCP endpoint is added. HTTP/OAuth: native serve --help.
Upstream-dependent features require their original providers/configuration.`);
  } else if (['db','upstream'].includes(command)) {
    const script = command === 'db' ? 'postgres.py' : 'upstreams.py';
    const p = spawnSync('python3', [`${ROOT}/scripts/${script}`, ...rest], { stdio: 'inherit' });
    if (p.error) throw p.error;
    process.exitCode = p.status ?? 1;
  } else if (command === 'migrate') {
    const engine = await connect({ migrate: true });
    await engine.disconnect();
    console.log('Native and ultrabrain schemas ready.');
  } else {
    const forwarded = command === 'native' ? rest : command === 'mcp' ? ['serve','--surface','full', ...rest] : args;
    if (['self-update','update','upgrade','init'].includes(forwarded[0])) {
      throw new Error('Use managed db init + migrate, or upstream prepare. Native self-update/init could bypass pins or replace PostgreSQL with PGLite.');
    }
    prepareEnvironment();
    await installPlugin();
    process.argv = [process.execPath, `${ROOT}/vendor/gbrain/src/cli.ts`, ...forwarded];
    await loadNative('src/cli.ts');
  }
} catch (error) {
  // Native paths have their own redaction; do not print a connection URL or raw provider response here.
  console.error(`ultrabrain: ${error.code ?? error.name ?? 'error'}; ${['ENOENT','EACCES'].includes(error.code) ? 'Run db init and check private file permissions.' : 'Command failed; verify setup, configuration and upstream compatibility.'}`);
  if (process.env.ULTRABRAIN_DEBUG === '1') console.error(String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[database-url-redacted]'));
  process.exitCode = 1;
}
