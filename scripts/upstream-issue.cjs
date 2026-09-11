/** Trusted repository code. Remote refs are data, never executable workflow input. */
const fs=require('node:fs'),crypto=require('node:crypto');
module.exports=async function publish({github,context,core},path) {
  const report=JSON.parse(fs.readFileSync(path,'utf8'));
  const issues=await github.paginate(github.rest.issues.listForRepo,{...context.repo,state:'all',per_page:100});
  for(const [project,p] of Object.entries(report.projects)) {
    const failed=Object.entries(p.origins).filter(([,v])=>v.checked===false||v.error);
    const changed=Object.entries(p.origins).filter(([,v])=>v.changed===true);
    const release=p.latest_stable&&p.latest_stable.revision!==p.locked;
    if(!failed.length&&!changed.length&&!release) continue;
    const key=crypto.createHash('sha256').update(JSON.stringify([project,p])).digest('hex').slice(0,16);
    const marker=`<!-- ultrabrain-upstream-v2:${project}:${key} -->`;
    if(issues.some(i=>!i.pull_request&&i.body?.includes(marker))) continue;
    const lines=[marker,'','No code, service or database was upgraded.',`Locked: \`${p.locked}\``];
    for(const [repo,o] of changed) lines.push(`Candidate: ${repo} ${o.ref} ${o.revision}`);
    for(const [repo,o] of failed) lines.push(`CHECK FAILED: ${repo} (${o.error}); this is NOT "no update".`);
    if(release) lines.push(`Stable candidate: ${p.latest_stable.ref} ${p.latest_stable.revision}`);
    if(p.latest_same_major) lines.push(`Same-major candidate: ${p.latest_same_major.ref}`);
    lines.push('','Review docs/UPGRADES.md and compat/upstream-features.json. Use Prepare upstream candidate to create a draft PR and explicitly dispatch read-only CI. License, authorization, migration and memory-quality approval are still required.');
    await github.rest.issues.create({...context.repo,title:`Upstream ${failed.length?'check incomplete':'review'}: ${project} [${key}]`,body:lines.join('\n')});
  }
};
