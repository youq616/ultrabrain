// Negative capability guard for actual source and installed Node execution.
// It does not substitute snapshot logic or filesystem reads.
'use strict';
const deny=()=>{throw Error('OFFLINE_FORBIDDEN_OPERATION');};
for(const [name,keys]of Object.entries({
  'node:child_process':['exec','execFile','spawn','fork','execSync','execFileSync','spawnSync'],
  'node:http':['request','get','createServer'],'node:https':['request','get','createServer'],
  'node:net':['connect','createConnection','createServer'],'node:tls':['connect','createServer'],
  'node:dgram':['createSocket'],'node:dns':['lookup','resolve'],
  'node:fs':['writeFile','writeFileSync','appendFile','appendFileSync','unlink','unlinkSync','rm','rmSync','mkdir','mkdirSync',
    'rename','renameSync','createWriteStream','truncate','truncateSync'],
  'node:fs/promises':['writeFile','appendFile','unlink','rm','mkdir','rename','truncate'],
}))for(const key of keys)require(name)[key]=deny;
const net=require('node:net');net.Socket.prototype.connect=deny;net.Server.prototype.listen=deny;
globalThis.fetch=deny;
require('node:module').syncBuiltinESMExports();
