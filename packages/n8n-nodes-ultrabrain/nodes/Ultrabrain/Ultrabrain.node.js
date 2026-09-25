'use strict';
const {NodeOperationError}=require('n8n-workflow');
const runtime=require('../../runtime.cjs');
class Ultrabrain {
  constructor() {
    this.description={displayName:'Ultrabrain',name:'ultrabrain',icon:'fa:brain',group:['transform'],version:1,
      description:'Retrieve governed Agent memory and explicitly save consented turns through authenticated MCP',
      defaults:{name:'Ultrabrain'},inputs:['main'],outputs:['main'],usableAsTool:false,
      credentials:[{name:'ultrabrainApi',required:true}],
      properties:[
        {displayName:'Operation',name:'operation',type:'options',default:'before_turn',noDataExpression:true,
          options:[{name:'Check Connection',value:'identity',action:'Check the authenticated identity'},
            {name:'Get Personal Memory Overview',value:'personal_overview',action:'Read owner-wide memory statistics'},
            {name:'Get Context Before Turn',value:'before_turn',action:'Get memory context before an agent turn'},
            {name:'Save Consented Turn',value:'after_turn',action:'Save a consented conversation turn'},
            {name:'Get Session Status',value:'session_status',action:'Get the state of a saved turn'},
            {name:'Resume Project',value:'resume_project',action:'Load a project checkpoint'}]},
        {displayName:'Overview Scope',name:'overviewScope',type:'options',default:'',noDataExpression:true,
          displayOptions:{show:{operation:['personal_overview']}},options:[{name:'Select Scope',value:''},{name:'My Owned Records Across All Projects',value:'owned-all-projects'}],
          description:'Private metadata only. Source-root credential and observed instance/actor pins required. Not a project-filtered or shared-record count.'},
        {displayName:'Consent to Read Overview for This Item',name:'overviewConsent',type:'boolean',default:false,
          displayOptions:{show:{operation:['personal_overview']}},description:'Whether to read owner-wide statistics for this item. No bodies, model calls or memory writes. n8n execution history may retain the result.'},
        {displayName:'Session ID',name:'sessionId',type:'string',default:'',required:true,
          displayOptions:{hide:{operation:['identity','personal_overview']}},description:'Stable application session ID, ASCII letters, numbers, underscore or hyphen; maximum 96 characters.'},
        {displayName:'Query',name:'query',type:'string',default:'',required:true,typeOptions:{rows:3},
          displayOptions:{show:{operation:['before_turn','resume_project']}}},
        {displayName:'Project ID',name:'projectId',type:'string',default:'',
          displayOptions:{show:{operation:['before_turn','resume_project']}},description:'Optional for context; required for Resume Project. The checkpoint must already exist.'},
        {displayName:'Event ID',name:'eventId',type:'string',default:'',required:true,
          displayOptions:{show:{operation:['after_turn','session_status']}},description:'Stable immutable ID from the producing app. Reuse the same ID and transcript for retries; do not derive it from a retry execution ID.'},
        {displayName:'Transcript',name:'transcript',type:'string',default:'',required:true,typeOptions:{rows:5},
          displayOptions:{show:{operation:['after_turn']}},description:'Already consented and redacted text, at most 64 KiB. No automatic capture or secret detection.'},
        {displayName:'Consent to Save This Item',name:'captureConsent',type:'boolean',default:false,
          displayOptions:{show:{operation:['after_turn']}},description:'Whether this item may be saved. The credential must also permit capture.'},
        {displayName:'Visibility',name:'visibility',type:'options',default:'private',
          displayOptions:{show:{operation:['after_turn']}},options:[{name:'Host Private',value:'private'},{name:'Shared Within Authorized Source',value:'world'}]},
        {displayName:'Memory Selection',name:'memoryPolicy',type:'options',default:'current',
          displayOptions:{show:{operation:['before_turn']}},options:[{name:'Current',value:'current'},{name:'Reviewed Only',value:'reviewed'},{name:'Explicit History',value:'history'}]},
        {displayName:'Summary Cache',name:'summary',type:'options',default:'prefer',
          displayOptions:{show:{operation:['before_turn']}},options:[{name:'Prefer Existing Summary',value:'prefer'},{name:'Require Existing Summary',value:'require'},{name:'Use Source Text',value:'off'}],description:'Never generates a summary or calls a model.'},
        {displayName:'Include Active Personal Memory',name:'includePersonal',type:'boolean',default:false,
          displayOptions:{show:{operation:['before_turn']}},description:'Whether to read explicitly active global and selected-project personal entries from this credential identity. Requires a source root and at least 4096 bytes.'},
        {displayName:'Include Governed Facts',name:'includeFacts',type:'boolean',default:false,
          displayOptions:{show:{operation:['before_turn']}},description:'Whether to combine current source-bound facts with pages; facts are not semantic matches to the query.'},
        {displayName:'Fact Entity',name:'factEntity',type:'string',default:'',
          displayOptions:{show:{operation:['before_turn'],includeFacts:[true]}},description:'Optional fixed entity. Empty uses native recent-fact selection.'},
        {displayName:'Evidence Budget (UTF-8 Bytes)',name:'budgetBytes',type:'number',default:16000,
          typeOptions:{minValue:512,maxValue:131072},displayOptions:{show:{operation:['before_turn']}},
          description:'Serialized evidence only, not model tokens or total prompt. At least 2048 with facts.'},
        {displayName:'Request Timeout (ms)',name:'timeoutMs',type:'number',default:30000,
          typeOptions:{minValue:1000,maxValue:120000}},
      ]};
  }
  async execute() {
    try{return [await runtime.execute(this)];}
    catch(e){
      const code=typeof e.code==='string'&&/^[a-z0-9_]{1,64}$/.test(e.code)?e.code:'adapter_failed';
      // Do not attach raw errors, input items, tokens or provider messages to n8n error reports.
      const outcome=e.memory_writes_requested===false?`read_delivery=${e.read_delivery==='unconfirmed'?'unconfirmed':'not_started'}; memory_writes_requested=false`:`delivery=${e.delivery==='unconfirmed'?'unconfirmed':'not_submitted'}`;
      throw new NodeOperationError(this.getNode(),`Ultrabrain: ${code}; ${outcome}`,
        {itemIndex:Number.isInteger(e.itemIndex)?e.itemIndex:0});
    }
  }
}
module.exports={Ultrabrain};
