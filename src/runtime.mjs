import { readFileSync, mkdirSync, lstatSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireThat } from './core.mjs';
import { registerPlugin } from './plugin.mjs';
import { applyMigrations, migrationStatus } from './migrations.mjs';
import { loadNative as load, nativeBindings } from './adapters/gbrain.mjs';
import { registerProjectPlugin } from './project-plugin.mjs';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const HOME = resolve(process.env.ULTRABRAIN_HOME ?? join(homedir(), '.local/share/ultrabrain'));
function privatePath(path, kind) {
  const st = lstatSync(path);
  requireThat(!st.isSymbolicLink() && st.uid === process.getuid() &&
    (st.mode & 0o077) === 0 && (kind === 'directory' ? st.isDirectory() : st.isFile()),
    'insecure_path', 'Managed paths must be owner-only, owned by the service user and not symlinks');
}
export function prepareEnvironment() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  privatePath(HOME, 'directory');
  // Deliberately never inherit a pre-existing ~/.gbrain or ambient external database URL.
  process.env.GBRAIN_HOME = join(HOME, 'gbrain');
  process.env.GBRAIN_SELF_UPGRADE_MODE = 'off';
  delete process.env.DATABASE_URL;
  delete process.env.GBRAIN_DATABASE_URL;
  const path = join(HOME, 'gbrain/config.json');
  privatePath(join(HOME, 'gbrain'), 'directory');
  privatePath(path, 'file');
  const statePath = join(HOME, 'postgres/state.json');
  privatePath(join(HOME, 'postgres'), 'directory');
  privatePath(statePath, 'file');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const bindingPath = join(HOME, 'postgres/runtime.json');
  privatePath(bindingPath, 'file');
  const binding = JSON.parse(readFileSync(bindingPath, 'utf8'));
  const pins = JSON.parse(readFileSync(join(ROOT, 'upstreams.lock.json'), 'utf8')).projects;
  requireThat(binding.postgres_revision === pins.postgres.revision &&
    binding.pgvector_revision === pins.pgvector.revision && binding.version === pins.postgres.version,
    'runtime_pin_mismatch', 'Stop services, build the pinned runtime, activate it and migrate before serving');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const url = new URL(config.database_url);
  requireThat(config.engine === 'postgres' && url.protocol === 'postgresql:' &&
    url.hostname === '127.0.0.1' && url.port === String(state.port) &&
    url.username === 'ultrabrain' && url.pathname === '/ultrabrain' &&
    decodeURIComponent(url.password) === state.app_password && !url.search && !url.hash,
    'external_database_refused', 'Use the managed local native PostgreSQL database');
  process.env.GBRAIN_DATABASE_URL = config.database_url;
  return config;
}
let registered;
export async function installPlugin() {
  if (registered) return registered;
  requireThat(typeof Bun !== 'undefined', 'bun_required', 'Runtime requires Bun >=1.3.11; pure tests run on Node');
  const {operations,validateParams,OperationError,context} = await nativeBindings();
  registered = registerPlugin(operations, { validateParams, OperationError,
    enforceClientSlugFence: context.enforceClientSlugFence });
  // Only these two wrappers delegate exclusively to the corresponding fenced native write.
  // Session extraction may touch entity pages; never grant it to prefix-bound clients.
  context.CLIENT_FENCED_WRITE_OPS.add('ultra_write');
  context.CLIENT_FENCED_WRITE_OPS.add('ultra_delete');
  registered = [...registered, ...registerProjectPlugin(operations, { OperationError })];
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
    const [schemaPath] = await engine.executeRaw('SELECT current_schema() AS schema');
    requireThat(schemaPath.schema === 'public', 'unsafe_search_path',
      'Run db init to pin the native schema to public; reconcile any shadow tables before migrating');
    if (migrate) {
      await engine.initSchema();
      await applyMigrations(engine);
    }
    const status = await migrationStatus(engine);
    requireThat(status.pending.length === 0, 'pending_migrations', 'Run migrate before serving this release');
    return engine;
  } catch (e) { await engine.disconnect(); throw e; }
}
export { load as loadNative };
