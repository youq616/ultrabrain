import { projectTools } from './projects.mjs';
import { UltraError, requireThat } from './core.mjs';
const string = (description, required=true) => ({type:'string',description,required});
const project_id=string('Project identifier within the authenticated source.');
const definitions=[
 ['ultra_project_load','load',false,{project_id},'Read the current structured project checkpoint; source-shared, not a private personal memory.'],
 ['ultra_project_save','save',true,{project_id,event_id:string('Stable immutable update identifier'),
   expected_revision:{type:'number',required:true,description:'0 creates; otherwise exact current revision'},
   state:{type:'object',required:true,description:'goal, constraints, decisions, tasks, blockers, next_actions; see docs/RELIABILITY.md'}},
  'Save a checkpoint with optimistic concurrency and replay protection. Verified tasks require host execution receipt IDs.'],
 ['ultra_project_resume','resume',false,{project_id,query:string('Current request; combined with checkpoint context',false)},
  'Restore project state and construct a context-aware retrieval query. This does not resume processes or authorize tool execution.'],
 ['ultra_project_history','history',false,{project_id,limit:{type:'number'},before_revision:{type:'number'}},
  'Read bounded immutable checkpoint history using revision-based pagination.'],
 ['ultra_project_forget','forget',true,{project_id,expected_revision:{type:'number',required:true},confirm:string('Exact project id')},
  'Forget live project state, history and execution receipts; prevent replay resurrection. Does not erase independent pages or backups.'],
];
export const PROJECT_TOOL_NAMES=definitions.map(d=>d[0]);
export function registerProjectPlugin(operations,{OperationError}) {
  for(const [name,method,mutating,params,description] of definitions) {
    requireThat(!operations.some(o=>o.name===name),'upstream_contract_changed',`Operation collision: ${name}`);
    operations.push({name,scope:mutating?'write':'read',mutating,params,description,area:'ultrabrain',
      async handler(ctx,p) {
        try {return await projectTools(ctx)[method](p);}
        catch(e) {if(e instanceof UltraError) throw new OperationError(e.code,e.message);throw e;}
      }});
  }
  return PROJECT_TOOL_NAMES;
}
