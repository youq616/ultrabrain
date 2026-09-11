/** Bun preload: register extensions before the untouched upstream CLI runs as main. */
import { prepareEnvironment, installPlugin } from './runtime.mjs';
prepareEnvironment();
await installPlugin();
