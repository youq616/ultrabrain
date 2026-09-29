'use strict';
class UltrabrainApi {
  constructor() {
    this.name='ultrabrainApi';this.displayName='Ultrabrain API';
    this.documentationUrl='https://github.com/youq616/ultrabrain/blob/main/docs/N8N-INTEGRATION.md';
    this.properties=[
      {displayName:'MCP Endpoint',name:'endpoint',type:'string',default:'',required:true,
        placeholder:'https://memory.example.com/mcp',description:'Trusted server configuration. HTTPS required except explicit loopback HTTP.'},
      {displayName:'Bearer Token',name:'token',type:'string',typeOptions:{password:true},default:'',required:true},
      {displayName:'Memory Root URI',name:'rootUri',type:'string',default:'ultra://default/',required:true,
        description:'Must match the authenticated source. Capture requires a source root, not a directory.'},
      {displayName:'Allow Conversation Capture',name:'allowCapture',type:'boolean',default:false,
        description:'Whether nodes using this credential may save explicitly consented turns. Reading never enables capture.'},
      {displayName:'Allow Source-Shared Capture',name:'allowSharedCapture',type:'boolean',default:false,
        description:'Whether capture may use world visibility within this authorized source. Private remains host-private, not remote-user-private.'},
      {displayName:'Candidate Project ID',name:'candidateProject',type:'string',default:'',
        description:'Trusted project for List Personal Candidates. Empty permits global-only selection; nonempty enables global plus this project. Never read from an input item.'},
      {displayName:'Inspection Project ID',name:'inspectProject',type:'string',default:'',
        description:'Trusted project for Inspect Personal Memory. Independent of Candidate Project ID; empty allows global-only. Never selected from an input item.'},
      {displayName:'Review Project ID',name:'reviewProject',type:'string',default:'',
        description:'Independent trusted project for Review Personal Memory; never inferred from candidate/inspection project or item JSON.'},
      {displayName:'Allow Memory Activation',name:'allowMemoryActivation',type:'boolean',default:false,
        description:'Whether explicit single-version activation is permitted by this client. The server still requires owned-record write scope; does not enable capture.'},
      {displayName:'Allow Memory Archive',name:'allowMemoryArchive',type:'boolean',default:false,
        description:'Whether explicit single-version archive is permitted. Archive is not physical deletion. Independent of activation and capture.'},
      {displayName:'Allow Source-Shared Activation',name:'allowSourceActivation',type:'boolean',default:false,
        description:'Additional activation gate for source-shared records; each decision still needs explicit shared consent.'},
      {displayName:'Allow Memory Correction',name:'allowMemoryCorrection',type:'boolean',default:false,
        description:'Whether this credential may explicitly replace one owned memory and reset it to candidate. Independent of capture, activation and archive grants.'},
      {displayName:'Allow Correction Project or Visibility Change',name:'allowCorrectionScopeChange',type:'boolean',default:false,
        description:'Whether an explicit correction may change project or visibility within its fixed scope. Requires a separate per-operation confirmation; does not authorize activation.'},
      {displayName:'Correction Project ID',name:'correctionProject',type:'string',default:'',
        description:'Independent trusted project for corrections. Empty permits global-only; nonempty permits global and this project. Both original and replacement projects must fit.'},
      {displayName:'Expected Instance UUID',name:'expectedInstance',type:'string',default:'',
        description:'Pin from Check Connection; required for Personal Memory Overview, List Personal Candidates, Inspect Personal Memory, Review Personal Memory and Correct Personal Memory, optional for other operations. Backups retain this logical instance identity.'},
      {displayName:'Expected Actor SHA-256',name:'expectedActor',type:'string',default:'',
        description:'Pin from Check Connection; required for Personal Memory Overview, List Personal Candidates, Inspect Personal Memory, Review Personal Memory and Correct Personal Memory, optional for other operations. A different token may represent a different actor.'},
    ];
  }
}
module.exports={UltrabrainApi};
