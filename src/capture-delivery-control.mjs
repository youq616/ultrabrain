/** Local journal delivery gate. A checksum is an observation for CAS, not a
 * credential or server receipt. The private owner account remains trusted. */
import {randomUUID} from 'node:crypto';
import {requireThat,UltraError,sha256} from './core.mjs';
export const DELIVERY_CONTROL_FILE='delivery-control.json';
const fields=['format','binding_sha256','state','revision','change_id','changed_at'];
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const date=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
export function decodeDeliveryControl(bytes,bindingHash){
 let text,r;
 try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);r=JSON.parse(text);}
 catch{throw new UltraError('outbox_corrupt','Invalid delivery control; preserve it for inspection');}
 // This is a machine-owned journal, not user configuration. Canonical spelling
 // also rejects duplicate keys, number coercions, BOMs and escaped-key aliases.
 requireThat(r&&typeof r==='object'&&!Array.isArray(r)&&Object.keys(r).length===fields.length&&fields.every(k=>Object.hasOwn(r,k))&&
   text===JSON.stringify(r)+'\n'&&r.format===1&&hash(r.binding_sha256)&&['running','paused'].includes(r.state)&&
   Number.isSafeInteger(r.revision)&&r.revision>=1&&uuid(r.change_id)&&date(r.changed_at),
   'outbox_corrupt','Invalid delivery control; no implicit repair or resume');
 requireThat(r.binding_sha256===bindingHash,'identity_mismatch','Delivery control belongs to another journal binding');
 return r;
}
export function deliveryControlView(record=null){
 return {format:1,state:record?.state??'running',revision:record?.revision??0,changed_at:record?.changed_at??null,
   control_sha256:record?sha256(JSON.stringify(record)+'\n'):null,persisted:record!==null};
}
export function nextDeliveryControl(previous,bindingHash,state){
 requireThat(hash(bindingHash)&&['running','paused'].includes(state),'invalid_params','Invalid delivery control');
 const revision=previous?.revision??0;
 requireThat(Number.isSafeInteger(revision)&&revision>=0&&revision<Number.MAX_SAFE_INTEGER,
   'outbox_control_exhausted','Delivery control revision exhausted; automatic reset is forbidden');
 return {format:1,binding_sha256:bindingHash,state,revision:revision+1,change_id:randomUUID(),changed_at:new Date().toISOString()};
}
export function requireResumeObservation(expectedHash,confirm){
 requireThat(typeof expectedHash==='string'&&hash(expectedHash)&&confirm===true,
   'invalid_params','Exact current pause checksum and explicit resume confirmation required');
}
