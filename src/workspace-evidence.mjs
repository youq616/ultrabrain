/** Read-only Git observations, NOT a hermetic build or a remote CI attestation.
 * No filenames, repository paths, remote URLs or diff contents leave this module.
 * The host's Git executable and repository configuration remain trusted inputs.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { sha256, requireThat } from './core.mjs';
const execute = promisify(execFile);
const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export function codeRevision(value) {
  requireThat(typeof value === 'string' && revisionPattern.test(value),
    'invalid_params', 'code_revision must be a full lowercase Git commit id (40 or 64 hex digits)');
  return value;
}
function gitEnvironment() {
  // A caller's GIT_DIR/WORK_TREE/INDEX_FILE must not redirect the observation to
  // some other clean checkout. Do not inherit injected -c config or global hooks.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_OPTIONAL_LOCKS:'0', GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', LC_ALL:'C' };
}
export async function observeWorkspace(cwd) {
  const git = async (...args) => (await execute('git', ['-c','core.fsmonitor=false',
    '-c','core.untrackedCache=false', ...args], {cwd, env:gitEnvironment(),
    timeout:2000, killSignal:'SIGKILL', maxBuffer:1048576, encoding:'utf8'})).stdout;
  try {
    const first = (await git('rev-parse','--verify','HEAD')).trim();
    codeRevision(first);
    const root = await realpath((await git('rev-parse','--show-toplevel')).trimEnd());
    const status = await git('status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=none');
    // status can hide modifications under assume-unchanged / skip-worktree bits.
    const index = await git('ls-files','-v','-z');
    const flagsClear = index.split('\0').every(entry => !entry || (!/^[a-z]/.test(entry) && entry[0] !== 'S'));
    const last = (await git('rev-parse','--verify','HEAD')).trim();
    if (first !== last) return {available:false, reason:'changed_during_observation'};
    return {available:true, commit:first, clean:status.length === 0 && flagsClear, index_flags_clear:flagsClear, root_sha256:sha256(root)};
  } catch {
    // Includes unborn/bare/non-Git repositories, missing Git, timeout and limits.
    // Never return stderr: it can contain local paths or repository contents.
    return {available:false, reason:'git_observation_unavailable'};
  }
}
export function workspaceEvidence(before, after) {
  return {format:1, before, after,
    stable:before.available === true && after.available === true && before.clean === true && after.clean === true &&
      before.commit === after.commit && before.root_sha256 === after.root_sha256,
    scope:'Git HEAD and non-ignored worktree state at two instants; ignored files, environment, dependencies and transient changes are not attested'};
}
export function matchesCodeRevision(workspace, revision) {
  const b = workspace?.before, a = workspace?.after;
  return workspace?.format === 1 && b?.available === true && a?.available === true &&
    b.clean === true && a.clean === true && b.index_flags_clear === true && a.index_flags_clear === true && b.commit === revision && a.commit === revision &&
    typeof b.root_sha256 === 'string' && /^[a-f0-9]{64}$/.test(b.root_sha256) && b.root_sha256 === a.root_sha256;
}
