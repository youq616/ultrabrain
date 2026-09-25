/** Test-only stdio proxy launcher. Do not forward the parent's full environment.
 * The official SDK supplies its normal safe default variables. HTTP fixtures
 * must opt in to exactly their own short-lived bearer; stdio needs no bearer.
 */
export function clientProxyFixtureOptions(cli,profilePath,bearer){
 const env={};
 if(bearer!==undefined){
  if(typeof bearer!=='string'||!/^gbrain_[a-f0-9]{64}$/.test(bearer))throw new TypeError('Invalid fixture bearer');
  env.ULTRABRAIN_KIT_FIXTURE=bearer;
 }
 return {command:'node',args:[cli,'mcp','--profile',profilePath],stderr:'pipe',env};
}
