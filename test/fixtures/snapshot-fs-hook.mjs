import * as fs from 'node:fs/promises';
export const state={};
export function reset(){Object.assign(state,{stats:0,opened:0,reads:0,closed:0,onStat:null,onOpen:null,onRead:null,onClose:null});}
reset();
export async function lstat(...args){
  state.stats++;const value=await fs.lstat(...args);await state.onStat?.(args[0],value);return value;
}
export async function open(...args){
  const handle=await fs.open(...args);state.opened++;await state.onOpen?.(args[0]);
  return {
    stat:options=>handle.stat(options),
    async read(...params){const value=await handle.read(...params);state.reads++;await state.onRead?.(args[0],state.reads,value);return value;},
    async close(){await handle.close();state.closed++;await state.onClose?.();},
  };
}
