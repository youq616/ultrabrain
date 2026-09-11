import { readFileSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireThat } from './core.mjs';
import { registerPlugin } from './plugin.mjs';
import { SESSION_SCHEMA } from './sessions.mjs';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const HOME = resolve(process.env.ULTRABRAIN_HOME ?? join(homedir(), '.local/share/ultrabrain'));
export function prepareEnvironment() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  requireThat((statSync(HOME).mode & 0o077) === 0, 'insecure_home', 'ULTRABRAIN_HOME must have mode 0700');
  // Deliberately never inherit a pre-existing ~/.gbrain or ambient external database URL.
  process.env.GBRAIN_HOME = join(HOME, 'gbrain');
  delete process.env.DATABASE_URL;
  delete process.env.GBRAIN_DATABASE_URL;
  const path = join(HOME, 'gbrain/config.json');
  requireThat((statSync(path).mode & 0o077) === 0, 'insecure_config', 'Database config must have mode 0600');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const url = new URL(config.database_url);
  requireThat(config.engine === 'postgres' && url.protocol === 'postgresql:' &&
    ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname),
    'external_database_refused', 'Use the managed local native PostgreSQL database');
  process.env.GBRAIN_DATABASE_URL = config.database_url;
  return config;
}
const load = path => import(new URL(`../vendor/gbrain/${path}`, import.meta.url));
let registered;
export async function installPlugin() {
  if (registered) return registered;
  requireThat(typeof Bun !== 'undefined', 'bun_required', 'Runtime requires Bun >=1.3.11; pure tests run on Node');
  const [{ operations }, { validateParams }, { OperationError }, context] = await Promise.all([
    load('src/core/operations.ts'), load('src/mcp/validate-params.ts'),
    load('src/core/ops/contract.ts'), load('src/core/ops/context.ts'),
  ]);
  // Private helper imports are confined to this adapter and covered by contract tests.
  requireThat(typeof context.enforceClientSlugFence === 'function', 'upstream_contract_changed', 'Missing write fence');
  registered = registerPlugin(operations, { validateParams, OperationError,
    enforceClientSlugFence: context.enforceClientSlugFence });
  return registered;
}
export async function connect({ migrate = false } = {}) {
  prepareEnvironment();
  await installPlugin();
  const [{ createEngine }, config, gateway] = await Promise.all([
    load('src/core/engine-factory.ts'), load('src/core/config.ts'), load('src/core/ai/gateway.ts'),
  ]);
  gateway.configureGatewayIfUninitialized();
  const cfg = config.toEngineConfig(config.loadConfig());
  const engine = await createEngine(cfg);
  try {
    await engine.connect(cfg);
    if (migrate) {
      await engine.initSchema();
      await engine.transaction(async tx => {
        for (const statement of SESSION_SCHEMA.split(';').filter(s => s.trim())) await tx.executeRaw(statement);
      });
    }
    return engine;
  } catch (e) { await engine.disconnect(); throw e; }
}
export { load as loadNative };
