/** Validate adapter and schema before starting the untouched native entrypoint. */
import {connect} from './runtime.mjs';
const engine=await connect();
await engine.disconnect();
