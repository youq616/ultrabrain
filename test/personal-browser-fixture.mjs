/** Start an isolated synthetic console and drive the shipped real-browser test. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {connect,ROOT} from '../src/runtime.mjs';
import {startPersonalConsole} from '../src/personal-console.mjs';
assert.equal(process.env.ULTRABRAIN_TEST_ALLOW_WRITE,'1','Only use an isolated test database');
const engine=await connect(),source='browser-'+randomBytes(5).toString('hex'),token=randomBytes(32).toString('hex');let ui;
try{
 await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[source]);
 ui=await startPersonalConsole({engine,source,token,port:0});
 const child=spawn(process.env.ULTRABRAIN_BROWSER_PYTHON??'python3',[ROOT+'/test/personal-console-browser.py'],{
  env:{...process.env,ULTRABRAIN_BROWSER_ORIGIN:ui.origin,ULTRABRAIN_BROWSER_TOKEN:token},cwd:ROOT,stdio:['ignore','inherit','inherit']});
 const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
 try{const code=await new Promise((done,fail)=>{child.once('error',fail);child.once('close',done);});assert.equal(code,0,'Real browser validation failed');}
 finally{clearTimeout(timer);}
}finally{await ui?.close();await engine.disconnect();}
