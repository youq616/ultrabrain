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
      {displayName:'Expected Instance UUID',name:'expectedInstance',type:'string',default:'',
        description:'Pin from Check Connection; required for Personal Memory Overview, optional for other operations. Backups retain this logical instance identity.'},
      {displayName:'Expected Actor SHA-256',name:'expectedActor',type:'string',default:'',
        description:'Pin from Check Connection; required for Personal Memory Overview, optional for other operations. A different token may represent a different actor.'},
    ];
  }
}
module.exports={UltrabrainApi};
