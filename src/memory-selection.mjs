/** Pure client/server selection contract; no database, filesystem or process access. */
import {requireThat} from './core.mjs';
export function mode(value='current') {
  requireThat(['current','reviewed','history'].includes(value),'invalid_params','memory_policy must be current, reviewed or history');
  return value;
}
export function policyAllows(policy,selection='current') {
  mode(selection);
  return selection==='history'||(selection==='reviewed'?policy.status==='active':policy.eligible===true);
}
