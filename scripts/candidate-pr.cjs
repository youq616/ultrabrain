/** Run only from reviewed default-branch code; never install/build upstream here. */
const fs=require('node:fs');
module.exports=async function publish({github,context,core}) {
  if(!fs.existsSync('upgrade-candidate.json')) {core.info('Already at requested revision; no candidate.');return;}
  const p=JSON.parse(fs.readFileSync('upgrade-candidate.json','utf8'));
  if(!['gbrain','openviking','postgres','pgvector'].includes(p.project)||
    !/^[a-f0-9]{40}$/.test(p.candidate)||p.gitlink_path!==`vendor/${p.project}`||
    p.branch!==`upstream/${p.project}-${p.candidate.slice(0,12)}`||p.fresh_fetch_verified!==true)
    throw new Error('Invalid candidate manifest');
  // Never overwrite an existing branch or silently replace an operator-reviewed PR.
  try {await github.rest.git.getRef({...context.repo,ref:`heads/${p.branch}`});
    core.info('Candidate branch already exists. Reuse its review; no force update.');return;
  } catch(e) {if(e.status!==404) throw e;}
  const base=await github.rest.git.getCommit({...context.repo,commit_sha:context.sha});
  const tree=await github.rest.git.createTree({...context.repo,base_tree:base.data.tree.sha,tree:[
    {path:'.gitmodules',mode:'100644',type:'blob',content:fs.readFileSync('.gitmodules','utf8')},
    {path:'upstreams.lock.json',mode:'100644',type:'blob',content:fs.readFileSync('upstreams.lock.json','utf8')},
    {path:p.gitlink_path,mode:'160000',type:'commit',sha:p.candidate},
    {path:`docs/upgrade-candidates/${p.project}-${p.candidate.slice(0,12)}.json`,mode:'100644',type:'blob',content:JSON.stringify(p,null,2)+'\n'}]});
  const commit=await github.rest.git.createCommit({...context.repo,message:`chore: review ${p.project} ${p.candidate}`,tree:tree.data.sha,parents:[context.sha]});
  await github.rest.git.createRef({...context.repo,ref:`refs/heads/${p.branch}`,sha:commit.data.sha});
  const pr=await github.rest.pulls.create({...context.repo,head:p.branch,base:context.payload.repository.default_branch,
    draft:true,title:`Upstream candidate: ${p.project} ${p.candidate.slice(0,12)}`,
    body:`Review only. Not a release.\n\nSource commit: ${p.candidate}\nCandidate commit: ${commit.data.sha}\nInstaller clean-fetch verified.\n\nRisk routing: ${p.risk_flags.join(', ')}\n\nRequired: adapter contract review, old-data migration rehearsal, authorization regression, applicable memory-quality evaluation and license review. New tool fingerprints intentionally fail closed. OpenViking pointer updates do not add runtime features. No production service or database was changed.`});
  // Pushes made with GITHUB_TOKEN do not reliably launch push CI. Keep testing in a
  // separate workflow whose permissions are contents:read, with no model/API secrets.
  await github.rest.actions.createWorkflowDispatch({...context.repo,workflow_id:'ci.yml',ref:p.branch});
  core.info(`Draft PR #${pr.data.number}; read-only CI dispatched at ${commit.data.sha}. No automatic merge.`);
};
