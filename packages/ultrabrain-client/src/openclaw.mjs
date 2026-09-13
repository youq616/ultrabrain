import {registerOpenClaw} from './native-adapters.mjs';
export default {
  id:'ultrabrain-personal',
  name:'Ultrabrain Personal',
  description:'Explicit-session, workspace-bound read-only personal context; no memory-slot replacement',
  register:registerOpenClaw,
};
