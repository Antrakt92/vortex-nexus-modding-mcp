'use strict';
const fs=(()=>{try{return require('original-fs');}catch(_){return require('node:fs');}})();
const path=require('node:path'),crypto=require('node:crypto');
const {createLocalInstallHostAdmission,normalizeAdditionalSources}=require('./local-install-host.cjs');
const stock=require('./stock-vortex-2.9.1-admission.json');
const {receipts}=require('./paths.cjs');
const OFFICIAL_HOST='ec3a29d58ea65a1ca84e456742c894a19efe96920a6710063d221d451a26d59a';
const need=(v,c)=>{if(!v)throw Error(c);};
const drive=p=>typeof p==='string'&&/^[a-z]:[\\/]/i.test(p);
const norm=p=>(drive(p)?path.win32.normalize(p):path.resolve(p)).replace(/\\/g,'/').toLowerCase();
const parent=p=>drive(p)?path.win32.dirname(p):path.dirname(p);
const fields=(v,allowed)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>allowed.includes(k));
const generation=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const isHash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function inspect(file,disk){
 need(typeof file==='string'&&(path.isAbsolute(file)||drive(file)),'COLLECTION_WIZARD_ADMISSION_PATH');
 for(let p=file;;p=parent(p)){
  const stat=disk.lstatSync(p,{bigint:true});need(!stat.isSymbolicLink(),'COLLECTION_WIZARD_ADMISSION_REPARSE');
  if(p===file)need(stat.isFile(),'COLLECTION_WIZARD_ADMISSION_NOT_FILE');
  if(parent(p)===p)break;
 }
 return generation(disk.lstatSync(file,{bigint:true}));
}
function readMetadata(file,disk){
 const stamp=inspect(file,disk);need(disk.statSync(file).size<=1024*1024,'COLLECTION_WIZARD_ADMISSION_LIMIT');
 const bytes=disk.readFileSync(file);need(inspect(file,disk)===stamp,'COLLECTION_WIZARD_METADATA_CHANGED');
 return {value:JSON.parse(bytes.toString('utf8')),proof:{path:file,generation:stamp,sha256:hash(bytes)}};
}
function validateHelpers(value){
 need(fields(value,['schema','reviewed','appAsarSha256','helpers'])&&value.schema==='collection-wizard-reviewed-helpers/1'&&value.reviewed===true&&value.appAsarSha256===OFFICIAL_HOST&&Array.isArray(value.helpers)&&value.helpers.length<=32,'COLLECTION_WIZARD_ADMISSION_INVALID');
 const seen=new Set();
 for(const row of value.helpers){
  need(fields(row,['folder','files','externalSources'])&&typeof row.folder==='string'&&/^[A-Za-z0-9_.-]{1,200}$/.test(row.folder)&&!['.','..'].includes(row.folder)&&!seen.has(row.folder.toLowerCase())&&Array.isArray(row.files)&&row.files.length>0&&row.files.length<=128,'COLLECTION_WIZARD_ADMISSION_INVALID');
  if(Object.hasOwn(row,'externalSources')){need(Array.isArray(row.externalSources)&&row.externalSources.length<=128,'COLLECTION_WIZARD_ADMISSION_INVALID');normalizeAdditionalSources(row.externalSources);}
  seen.add(row.folder.toLowerCase());const names=new Set();
  for(const file of row.files){
   need(fields(file,['path','sha256'])&&typeof file.path==='string'&&file.path.length>0&&!/[\\:\x00-\x1f]/.test(file.path)&&file.path.split('/').every(p=>p&&p!=='.'&&p!=='..')&&isHash(file.sha256),'COLLECTION_WIZARD_HELPER_FILE_INVALID');
   const name=file.path.toLowerCase();need(!names.has(name),'COLLECTION_WIZARD_HELPER_FILE_DUPLICATE');names.add(name);
  }
  need(names.has('index.js')||names.has('index.cjs'),'COLLECTION_WIZARD_HELPER_ENTRY_REQUIRED');
 }
 return value.helpers;
}
// A missing maintainer manifest admits no additional helper. Metadata itself is
// generation-pinned, so editing it cannot change a prepared click's admission.
function reviewedHelpers(file,disk=fs){
 need(typeof file==='string'&&path.isAbsolute(file),'COLLECTION_WIZARD_ADMISSION_PATH');
 if(!disk.existsSync(file))return[];
 return validateHelpers(readMetadata(file,disk).value);
}
function census(api){
 need(typeof api?.getLoadedExtensions==='function','COLLECTION_WIZARD_EXTENSIONS_UNAVAILABLE');
 const rows=api.getLoadedExtensions();need(Array.isArray(rows)&&rows.length<=256,'COLLECTION_WIZARD_EXTENSIONS_UNAVAILABLE');
 const identities=rows.map(row=>{
  need(row&&typeof row==='object'&&typeof row.dynamic==='boolean','COLLECTION_WIZARD_EXTENSIONS_UNAVAILABLE');
  need(row.path===undefined||typeof row.path==='string'&&path.isAbsolute(row.path),'COLLECTION_WIZARD_EXTENSION_PATH');
  need(!row.dynamic||typeof row.path==='string','COLLECTION_WIZARD_EXTENSION_PATH');
  need(row.name===undefined||typeof row.name==='string','COLLECTION_WIZARD_EXTENSION_IDENTITY');
  const identity={dynamic:row.dynamic,path:row.path===undefined?null:norm(row.path),name:row.name??null,
   id:row.info?.id??null,version:row.info?.version??null,bundled:row.info?.bundled??null};
  need((identity.id===null||typeof identity.id==='string')&&(identity.version===null||typeof identity.version==='string')&&(identity.bundled===null||typeof identity.bundled==='boolean'),'COLLECTION_WIZARD_EXTENSION_IDENTITY');
  return identity;
 });
 const keys=identities.map(row=>JSON.stringify(row));need(new Set(keys).size===keys.length,'COLLECTION_WIZARD_EXTENSION_DUPLICATE');
 return identities.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function freeze(value){if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
function createWizardHostAdmission(api,util,options={}){
 const disk=options.fsSyncImpl||fs;
 const packagePath=path.join(path.dirname(process.execPath),'resources/app.asar');
 const user=path.join(util.getVortexPath('userData'),'plugins'),bundled=path.join(path.dirname(packagePath),'app.asar.unpacked/bundledPlugins');
 const manifestPath=options.reviewedHelpersPath||path.join(path.dirname(receipts),'collection-wizard-reviewed-helpers.json');
 need(typeof manifestPath==='string'&&path.isAbsolute(manifestPath),'COLLECTION_WIZARD_ADMISSION_PATH');
 const ownRoot=norm(__dirname),provenancePath=path.join(__dirname,'provenance.json');
 let verifier=null,verifierKey=null,current=null;
 function assertCurrent(proof){
  need(proof&&proof===current,'COLLECTION_WIZARD_HOST_PROOF_REQUIRED');
  need(JSON.stringify(census(api))===JSON.stringify(proof.loadedExtensions),'COLLECTION_WIZARD_EXTENSIONS_CHANGED');
  for(const source of [...proof.sources,...proof.metadata])need(inspect(source.path,disk)===source.generation,'COLLECTION_WIZARD_SOURCE_GENERATION_CHANGED');
  if(proof.reviewedHelpersAbsent)need(!disk.existsSync(manifestPath),'COLLECTION_WIZARD_METADATA_CHANGED');
  need(JSON.stringify(census(api))===JSON.stringify(proof.loadedExtensions),'COLLECTION_WIZARD_EXTENSIONS_CHANGED');
  return proof;
 }
 const admit=async()=>{
  current=null;
  try{
   const loaded=census(api),metadata=[],present=disk.existsSync(manifestPath);
   const manifest=present?readMetadata(manifestPath,disk):null;
   const helpers=manifest?validateHelpers(manifest.value):[];if(manifest)metadata.push(manifest.proof);
   const provenance=readMetadata(provenancePath,disk);need(isHash(provenance.value.pluginSha256),'COLLECTION_WIZARD_ADMISSION_INVALID');metadata.push(provenance.proof);
   const dynamic=[],external=[];
   for(const extension of loaded){
    if(!extension.dynamic)continue;
    const root=extension.path;
    if(root===ownRoot){dynamic.push({path:path.resolve(__dirname),files:[{path:'index.js',sha256:provenance.value.pluginSha256}]});continue;}
    const kind=norm(path.dirname(root))===norm(bundled)?'bundled':norm(path.dirname(root))===norm(user)?'user':null;
    const folder=path.basename(root).toLowerCase();
    const known=stock.extensions.find(row=>row.kind===kind&&row.folder.toLowerCase()===folder);
    const helper=kind==='user'?helpers.find(row=>row.folder.toLowerCase()===folder):null;
    need(known||helper,'COLLECTION_WIZARD_UNREVIEWED_EXTENSION');dynamic.push({path:root,files:(known||helper).files});
    if(helper)external.push(...normalizeAdditionalSources(helper.externalSources));
   }
   need(dynamic.some(row=>norm(row.path)===ownRoot),'COLLECTION_WIZARD_ADAPTER_NOT_LOADED');
   need(stock.appAsarSha256===OFFICIAL_HOST,'COLLECTION_WIZARD_UNREVIEWED_HOST');
   const pinned=new Map([[norm(packagePath),OFFICIAL_HOST],...dynamic.flatMap(d=>d.files.map(f=>[norm(path.join(d.path,f.path)),f.sha256]))]),additionalSources=[];
   for(const file of external){const id=norm(file.path);if(pinned.has(id)){need(pinned.get(id)===file.sha256,'COLLECTION_WIZARD_SOURCE_HASH_CONFLICT');continue;}pinned.set(id,file.sha256);additionalSources.push(file);}
   const expected={appAsarSha256:OFFICIAL_HOST,dynamic,...(additionalSources.length?{additionalSources}: {})};
   const key=JSON.stringify({expected,loaded,metadata});
   if(!verifier||key!==verifierKey){verifier=createLocalInstallHostAdmission({packagePath,expected,api,fsImpl:options.fsImpl||fs.promises});verifierKey=key;}
   const sources=await verifier();
   need(sources.appAsarSha256===OFFICIAL_HOST,'COLLECTION_WIZARD_UNREVIEWED_HOST');
   const proof=freeze({...sources,sourceAdmitted:true,loadedExtensions:loaded,metadata,reviewedHelpersAbsent:!present});
   current=proof;return assertCurrent(proof);
  }catch(error){current=null;throw error;}
 };
 // This is deliberately synchronous: only real filesystem generations and the
 // admitted loaded census are checked between final native validation and click.
 Object.defineProperty(admit,'revalidate',{value:proof=>{try{return assertCurrent(proof);}catch(error){current=null;throw error;}}});
 return admit;
}
module.exports={createWizardHostAdmission,reviewedHelpers,OFFICIAL_HOST};
