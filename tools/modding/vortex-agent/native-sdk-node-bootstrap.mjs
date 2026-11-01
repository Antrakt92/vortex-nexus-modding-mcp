// Build-only producer for the fixed reviewed relay capsule, never an IPC/code tool.
import crypto from 'node:crypto';
import {isProxy,isSharedArrayBuffer} from 'node:util/types';

const MAX_CODE = 2 * 1024 * 1024;
const MAX_FRAME = 4 * 1024 * 1024;
const need = value => {if (!value) throw Error('NATIVE_SDK_BOOTSTRAP_INPUT_REFUSED');};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

/** Capture trusted build output before producing immutable source/envelope strings. */
export function buildNodeSDKBootstrap(codeBytes) {
  need(arguments.length === 1 && !isProxy(codeBytes) && Buffer.isBuffer(codeBytes)
    && Object.getPrototypeOf(codeBytes) === Buffer.prototype);
  // Fixed named observations cannot invoke caller getters/coercion hooks. Numeric
  // typed-array elements are copied through internal slots, never property reads.
  for (const name of ['length','byteLength','buffer','byteOffset','toString','valueOf',Symbol.toPrimitive]) {
    const descriptor = Object.getOwnPropertyDescriptor(codeBytes, name);
    need(descriptor === undefined || Object.hasOwn(descriptor, 'value'));
  }
  const typed = Object.getPrototypeOf(Uint8Array.prototype);
  const size = Object.getOwnPropertyDescriptor(typed, 'byteLength').get.call(codeBytes);
  const backing = Object.getOwnPropertyDescriptor(typed, 'buffer').get.call(codeBytes);
  need(Number.isSafeInteger(size) && size > 0 && size <= MAX_CODE && !isSharedArrayBuffer(backing));
  const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
  need(resizable === undefined || !resizable.call(backing));
  const copy = Buffer.alloc(size);
  Uint8Array.prototype.set.call(copy, codeBytes);
  need(!(copy[0] === 239 && copy[1] === 187 && copy[2] === 191));
  new TextDecoder('utf-8', {fatal: true}).decode(copy);
  const codeSHA256 = digest(copy);
  const envelope = JSON.stringify({schema:'native-sdk-node-capsule/1',code:copy.toString('base64')});
  need(Buffer.byteLength(envelope) <= MAX_FRAME);
  const envelopeSHA256 = digest(Buffer.from(envelope));
  // This is fixed bootstrap source. Neither code nor filesystem/module paths are
  // accepted from argv/env; only one digest-bound envelope comes over the pipe.
  const bootstrap = `'use strict';
const crypto=require('node:crypto'),{Module}=require('node:module'),vm=require('node:vm');
const MAX_FRAME=4194304,MAX_CODE=2097152;
const EXPECTED_ENVELOPE='${envelopeSHA256}',EXPECTED_CODE='${codeSHA256}';
const ALLOWED=new Set(['node:fs','node:path','node:crypto','node:util','node:util/types','node:child_process','node:url','node:net','node:events','url']);
let phase='reading',parts=[],size=0;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function remove(){process.stdin.removeListener('data',data);process.stdin.removeListener('end',end);process.stdin.removeListener('error',inputError);clearTimeout(receiveTimer);}
function refuse(){if(phase!=='reading')return;phase='refused';remove();parts=[];process.exitCode=65;process.stdin.destroy();process.stdout.end();process.stderr.end('Native SDK capsule refused.\\n',()=>process.exit(65));setTimeout(()=>process.exit(65),100).unref();}
function inputError(){refuse();}
function end(){refuse();}
function validate(frame){
 if(frame.length<1||frame.length>MAX_FRAME||hash(frame)!==EXPECTED_ENVELOPE)throw Error('envelope');
 const text=new TextDecoder('utf-8',{fatal:true}).decode(frame),value=JSON.parse(text);
 if(value===null||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||Object.keys(value)[0]!=='schema'||Object.keys(value)[1]!=='code'||value.schema!=='native-sdk-node-capsule/1'||typeof value.code!=='string'||JSON.stringify(value)!==text)throw Error('shape');
 if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.code))throw Error('base64');
 const bytes=Buffer.from(value.code,'base64');
 if(bytes.length<1||bytes.length>MAX_CODE||bytes.toString('base64')!==value.code||hash(bytes)!==EXPECTED_CODE)throw Error('code');
 return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
function evaluate(code){
 const filename='C:/__nmt_native_capsule__/relay.cjs',directory='C:/__nmt_native_capsule__';
 const owned=new Module(filename);owned.filename=filename;owned.paths=[];
 function restricted(id){if(typeof id!=='string'||!ALLOWED.has(id))throw Error('NATIVE_SDK_CAPSULE_REQUIRE_REFUSED');return require(id);}
 owned.require=restricted;
 // No dynamic-import callback: runtime ESM imports cannot fall through to Node's
 // filesystem loader. The build additionally checks emitted import closure.
 const wrapper=new vm.Script(Module.wrap(code),{filename}).runInThisContext();
 wrapper.call(owned.exports,owned.exports,restricted,owned,filename,directory);owned.loaded=true;
}
function data(chunk){
 if(phase!=='reading')return;
 if(!Buffer.isBuffer(chunk)||size+chunk.length>MAX_FRAME+1){refuse();return;}
 const at=chunk.indexOf(10);
 if(at===-1){if(size+chunk.length>MAX_FRAME){refuse();return;}size+=chunk.length;parts.push(Buffer.from(chunk));return;}
 if(at!==chunk.length-1){refuse();return;}
 let code;
 try{const frame=Buffer.concat([...parts,chunk.subarray(0,at)],size+at);code=validate(frame);}catch{refuse();return;}
 process.stdin.pause();remove();parts=[];phase='runner';
 // Runner syntax/primary exceptions intentionally reach Node's normal failure
 // handling; bootstrap never rewrites them as a capsule validation refusal.
 evaluate(code);process.stdin.resume();
}
const receiveTimer=setTimeout(refuse,10000);
process.stdin.on('data',data);process.stdin.on('end',end);process.stdin.on('error',inputError);process.stdin.resume();
`;
  need(Buffer.byteLength(bootstrap) <= 16 * 1024);
  return Object.freeze({bootstrap,envelope,codeSHA256});
}
