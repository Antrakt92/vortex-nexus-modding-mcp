"""Portable actual-AST qualification tests. No SDK/DB/app/native libraries imported.
All Windows API, native handles and filesystem observations are explicit facades.
Payloads are our own original synthetic55B data, not playable game archives.
"""
import ast,base64,builtins,copy,hashlib,json,ntpath,pathlib,stat,types,unittest
D=pathlib.Path(__file__).parent;SOURCE=D/'fixtures/native-runtime-work-products.py';SHA='de35b923d3ccab1d96c1188ce89a9d4d802e7a85e2e48616abaa310d19812d46'
# Historical regression DATA: only the original directory-check function.
# All other guard code in both lanes comes from the exact current fixture.
HISTORICAL_DIRECTORY_CHECK = '''
def _wf_exact_runtime_directories(runtime,rows):
 dirs={runtime};files={runtime/r['relative']for r in rows}
 for file in files:
  p=file.parent
  while p!=runtime:
   need(p!=p.parent,'WORK_RUNTIME_SCOPE');dirs.add(p);p=p.parent
 snapshots=[]
 for directory in dirs:
  before=os.lstat(directory);_wf_plain(before,True);names=sorted(p.name for p in directory.iterdir());wanted=sorted(p.name for p in dirs|files if p.parent==directory)
  need(names==wanted and len({n.casefold()for n in names})==len(names),'WORK_RUNTIME_EXACT_DIRECTORY_NAMES');snapshots.append((directory,_wf_gen(before),names))
 for directory,generation,names in snapshots:
  need(_wf_gen(os.lstat(directory))==generation and sorted(p.name for p in directory.iterdir())==names,'WORK_RUNTIME_DIRECTORY_DRIFT')
'''
VOLUME=(1<<64)-7;FILEBASE=(1<<120)+123456789
h=lambda b:hashlib.sha256(b).hexdigest()
text=lambda v:json.dumps(v,separators=(',',':'),ensure_ascii=False)
ident=lambda n:{'schema':'win-file-id128/1','volumeSerialNumber':str(VOLUME),'fileId':str(FILEBASE+n)}

class Path:
 def __init__(self,fs,p):self.fs=fs;self.p=pathlib.PurePosixPath(str(p))
 def __str__(self):return str(self.p)
 def __hash__(self):return hash((id(self.fs),self.p))
 def __eq__(self,o):return isinstance(o,Path)and self.fs is o.fs and self.p==o.p
 def __truediv__(self,x):return Path(self.fs,self.p/str(x))
 @property
 def parent(self):return Path(self.fs,self.p.parent)
 @property
 def parents(self):return tuple(Path(self.fs,p)for p in self.p.parents)
 @property
 def name(self):return self.p.name
 def relative_to(self,p):return self.p.relative_to(p.p)
 def iterdir(self):return iter([Path(self.fs,p)for p in sorted(self.fs.rows)if p!=str(self)and pathlib.PurePosixPath(p).parent==self.p])

class Memory:
 def __init__(self):self.rows={};self.fds={};self.nextfd=10;self.open_calls=[];self.close_attempts=[];self.read_calls=0;self.read_error=None;self.close_error=None;self.drift=False
 def path(self,p):return p if isinstance(p,Path)else Path(self,p)
 def directory(self,p):
  p=str(p)
  if p in self.rows:return
  parent=str(pathlib.PurePosixPath(p).parent)
  if parent!=p:self.directory(parent)
  self.rows[p]={'dir':True,'data':b'','identity':ident(0),'reparse':False,'nlink':1,'ctime':1,'mtime':1,'pyino':len(self.rows)+1}
 def file(self,p,data,identity=None):
  p=str(p);self.directory(pathlib.PurePosixPath(p).parent);self.rows[p]={'dir':False,'data':bytes(data),'identity':identity or ident(9),'reparse':False,'nlink':1,'ctime':1,'mtime':1,'pyino':len(self.rows)+1}
 def sample(self,row):return types.SimpleNamespace(st_dev=7,st_ino=row['pyino'],st_size=len(row['data']),st_mtime_ns=row['mtime'],st_ctime_ns=row['ctime'],st_nlink=row['nlink'],st_mode=(stat.S_IFDIR|0o700)if row['dir']else(stat.S_IFREG|0o600),st_file_attributes=0x400 if row['reparse']else 0)
 def lstat(self,p):return self.sample(self.rows[str(p)])
 def fstat(self,fd):return self.sample(self.rows[self.fds[fd]['p']])
 def open(self,p,flags):
  self.open_calls.append((str(p),flags));fd=self.nextfd;self.nextfd+=1;self.fds[fd]={'p':str(p),'offset':0};return fd
 def read(self,fd,n):
  self.read_calls+=1
  if self.read_error is not None:raise self.read_error
  f=self.fds[fd];r=self.rows[f['p']];raw=r['data'][f['offset']:f['offset']+n];f['offset']+=len(raw)
  if self.drift:r['ctime']+=1
  return raw
 def close(self,fd):
  self.close_attempts.append(fd)
  if self.close_error is not None:raise self.close_error
  del self.fds[fd]
 def census(self,root):
  prefix=str(root).rstrip('/')+'/';rows=[]
  for p,row in self.rows.items():
   if p.startswith(prefix):
    if row['reparse']:raise RuntimeError('CENSUS_REPARSE')
    if not row['dir']:rows.append({'relative':p[len(prefix):],'bytes':len(row['data']),'sha256':h(row['data'])})
  return sorted(rows,key=lambda r:r['relative'])

class ScalarMeta(type):
 def __mul__(cls,count):
  class Array:
   _size=cls._size*count;_align=cls._align
   def __init__(self):self.data=bytearray(count)
   def __bytes__(self):return bytes(self.data)
  return Array
class Scalar(metaclass=ScalarMeta):
 _size=4;_align=4
 def __init__(self,value=0):self.value=value
class Field:
 def __init__(self,name,offset):self.name=name;self.offset=offset
 def __get__(self,obj,cls):return self if obj is None else obj.values[self.name]
 def __set__(self,obj,value):obj.values[self.name]=value
class StructureMeta(type):
 def __new__(meta,name,bases,ns):
  cls=super().__new__(meta,name,bases,ns);offset=0;alignment=1
  for key,kind in ns.get('_fields_',[]):
   alignment=max(alignment,kind._align);offset=(offset+kind._align-1)//kind._align*kind._align;setattr(cls,key,Field(key,offset));offset+=kind._size
  cls._size=(offset+alignment-1)//alignment*alignment;cls._align=alignment;return cls
class Structure(metaclass=StructureMeta):
 def __init__(self):
  self.values={}
  for key,kind in self._fields_:self.values[key]=0 if issubclass(kind,Scalar)else kind()

class NativeFacade:
 def __init__(self,m):
  self.m=m;self.dll_calls=[];self.handle_calls=[];self.queries=[];self.bad_pointer=False;self.fail_query=False;self.override_identity=None;self.sequence=[]
  self.Pointer=ScalarMeta('c_void_p',(Scalar,),{'_size':8,'_align':8});self.Int=ScalarMeta('c_int',(Scalar,),{'_size':4,'_align':4});self.U32=ScalarMeta('c_uint32',(Scalar,),{'_size':4,'_align':4});self.U64=ScalarMeta('c_uint64',(Scalar,),{'_size':8,'_align':8});self.U8=ScalarMeta('c_ubyte',(Scalar,),{'_size':1,'_align':1})
  def sizeof(value):
   if value is self.Pointer and self.bad_pointer:return 4
   return value._size
  self.C=types.SimpleNamespace(Structure=Structure,c_void_p=self.Pointer,c_int=self.Int,c_uint32=self.U32,c_uint64=self.U64,c_ubyte=self.U8,sizeof=sizeof,byref=lambda x:x,WinDLL=self.dll)
  self.crt=types.SimpleNamespace(get_osfhandle=self.handle)
 def handle(self,fd):self.handle_calls.append(fd);assert fd in self.m.fds;return(1<<36)+fd
 def dll(self,name,**kwargs):
  self.dll_calls.append((name,kwargs));assert name=='kernel32.dll'and kwargs=={'use_last_error':True}
  def query(handle,info_class,info,size):
   self.queries.append((handle.value,info_class,size));assert info_class==18 and size==24 and handle.value>(1<<32);fd=handle.value-(1<<36)
   if self.fail_query:return 0
   identity=self.sequence.pop(0)if self.sequence else self.override_identity or self.m.rows[self.m.fds[fd]['p']]['identity'];info.VolumeSerialNumber=int(identity['volumeSerialNumber']);info.FileId.Identifier.data[:]=int(identity['fileId']).to_bytes(16,'little');return 1
  self.last_query=query;return types.SimpleNamespace(GetFileInformationByHandleEx=query)
 def importer(self,name,*args,**kwargs):
  if name=='ctypes':return self.C
  if name=='msvcrt':return self.crt
  raise AssertionError('unapproved import '+name)

def environment(variant='v3'):
 raw=SOURCE.read_bytes();assert h(raw)==SHA;tree=ast.parse(raw);m=Memory();native=NativeFacade(m)
 if variant=='v2':
  historical=ast.parse(HISTORICAL_DIRECTORY_CHECK).body
  assert len(historical)==1 and isinstance(historical[0],ast.FunctionDef) and historical[0].name=='_wf_exact_runtime_directories'
  tree.body=[historical[0] if isinstance(node,ast.FunctionDef) and node.name=='_wf_exact_runtime_directories' else node for node in tree.body]
 else:assert variant=='v3'
 def need(v,c):
  if not v:raise RuntimeError(c)
 os=types.SimpleNamespace(name='nt',O_RDONLY=0,O_BINARY=0,O_NOINHERIT=0,O_NOFOLLOW=0,lstat=m.lstat,open=m.open,fstat=m.fstat,read=m.read,close=m.close,path=ntpath)
 namespace={'__name__':'actual_work_product_AST_fixture','__builtins__':{**vars(builtins),'__import__':native.importer},'base64':base64,'hashlib':hashlib,'json':json,'os':os,'pathlib':types.SimpleNamespace(Path=m.path,PurePosixPath=pathlib.PurePosixPath),'stat':stat,'sys':types.SimpleNamespace(platform='win32',version_info=(3,14)),'need':need,'census':m.census}
 nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef)or isinstance(n,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='_FIXTURE_PAYLOADS'for t in n.targets)]
 exec(compile(ast.Module(body=nodes,type_ignores=[]),str(SOURCE),'exec'),namespace);return namespace,m,native

def onefile():
 e,m,n=environment();p=m.path('/own/file');m.file(p,b'hello',ident(1));return e,m,n,p

def fixture(variant='v3'):
 e,m,n=environment(variant);root=m.path('/fixture');runtime=root/'runtime';custody=root/'observations/custody';m.directory(runtime);m.directory(custody);ops=[{'operationId':'op_'+'1'*32,'nativeJobId':'exec_'+'2'*32},{'operationId':'op_'+'3'*32,'nativeJobId':'exec_'+'4'*32}];records={};captured={}
 for number,op in enumerate(ops,1):
  mod='FixtureCancel'+('One'if number==1 else'Two');download,archive,member,total,digest=e['_FIXTURE_PAYLOADS'][mod];payload=base64.b64decode('T1dOIFNZTlRIRVRJQyBURVNUIERBVEEgMQpOb3QgYSBwbGF5YWJsZSBnYW1lIGFyY2hpdmUuCg=='if number==1 else'T1dOIFNZTlRIRVRJQyBURVNUIERBVEEgMgpOb3QgYSBwbGF5YWJsZSBnYW1lIGFyY2hpdmUuCg==');assert len(payload)==55 and h(payload)==digest
  binding={**op,'requestSHA256':'a'*64,'rendererGeneration':'renderer_'+'b'*32,'managerScope':'manager-own-1','modId':mod};request={'schema':'native-dispatch-request/1','contractId':'tracked-new-disabled-dispatch/1',**op,'rendererGeneration':binding['rendererGeneration'],'managerScope':binding['managerScope'],'plan':{'family':'tracked-new-disabled','options':{'enabled':False,'deploy':False},'package':{'expectedModId':mod,'downloadId':download,'fileName':archive,'payload':{member:digest},'expectedUncompressedBytes':55}}};request_raw=text(request).encode();binding['requestBytesSHA256']=h(request_raw)
  prepared={'workerLifetime':'worker_'+str(number)*32,'packetSHA256':'c'*64};destination={'parent':str(root/'staging'),'leaf':mod,'directoryIdentity':ident(100+number)};proof={'schema':'owned-zip-copy-proof/1','binding':{k:binding[k]for k in ['operationId','nativeJobId','requestSHA256','rendererGeneration']},'workerLifetime':prepared['workerLifetime'],'packetSHA256':prepared['packetSHA256'],'copiedFiles':1,'totalBytes':55,'files':[{'path':member,'bytes':55,'sha256':digest,'sourceIdentity':ident(number*10+1),'destinationIdentity':ident(number*10+3)}],'destination':destination,'effectsAllowed':False,'nativeInstallAccepted':False,'persistenceVerified':False};proof_raw=json.dumps(proof,separators=(',',':'),ensure_ascii=True,sort_keys=True).encode();meta={'identity':ident(number*10+2),'bytes':len(proof_raw),'sha256':h(proof_raw),'files':1,'totalBytes':55};oproot=runtime/'local-state/owned-zip-worker-work'/op['operationId'];m.file(oproot/'CopyProof.json',proof_raw,meta['identity']);m.file(oproot/'Extract'/member,payload,proof['files'][0]['sourceIdentity'])
  closed={'phase':'released','sdk':{'phase':'released','childClosed':True,'destination':destination,'copyProof':meta,'worker':{'phase':'released','errorCode':None,'workRoot':str(oproot),'copyProof':meta,'destination':destination}}};record={'binding':binding,'requestBase64':base64.b64encode(request_raw).decode(),'copyProofBase64':base64.b64encode(proof_raw).decode(),'preparedJSON':text(prepared),'workerClosedJSON':text(closed),'ownershipHoldJSON':text({'copyProofSHA256':h(proof_raw)})};raw=(text(record)+'\n').encode();m.file(custody/(op['operationId']+'.json'),raw);records[op['operationId']]=record;captured[op['operationId']]={'binding':copy.deepcopy(binding),'captureSHA256':h(raw)}
 e.update(E=root,CUSTODY=custody,execution_bindings=lambda:({}, {'rootDecision':{'newOperations':ops}}),execution_capture=lambda p,op:copy.deepcopy(captured[op['operationId']]))
 # Explicit prevalidated journal/immutable-source collaborators for GLOBAL union
 # tests. Their semantic validation is covered by retained runtime adapter tests.
 for i in range(17):m.file(runtime/('tools/module-'+str(i)),('BASE'+str(i)).encode())
 journal=[]
 for i in range(4):
  for kind,leaf in [('operations','intent.json'),('jobs','binding.json'),('terminals','terminal.json')]:
   rel='local-state/vortex-agent-build/native-install-executor/'+kind+'/unit-'+str(i)+'/'+leaf;data=('JOURNAL'+str(i)+kind).encode();m.file(runtime/rel,data);journal.append({'relative':rel.split('native-install-executor/',1)[1],'bytes':len(data),'sha256':h(data)})
 e['journal_layout']=lambda:copy.deepcopy(journal)
 rows=m.census(runtime);base17=[r for r in rows if r['relative'].startswith('tools/')];old6=[r for r in rows if 'native-install-executor/'in r['relative']and('/unit-0/'in r['relative']or'/unit-1/'in r['relative'])];plan={'runtimeFiles':copy.deepcopy(sorted(base17+old6,key=lambda r:r['relative']))};assert len(plan['runtimeFiles'])==23
 return e,m,n,ops,records,captured,plan

class FileIdTests(unittest.TestCase):
 def test_full_module_initialization_is_portable_and_inert(self):
  raw=SOURCE.read_bytes();self.assertEqual(h(raw),SHA);imports=[];forbidden=[]
  def refuse(*args,**kwargs):
   forbidden.append((args,kwargs));raise AssertionError('module initialization attempted file/process I/O')
  # The full module, including its import statements, executes here. Its OS and
  # path capabilities are denied rather than inherited from this test process.
  safe_os=types.SimpleNamespace(name='posix',open=refuse,read=refuse,write=refuse,close=refuse,lstat=refuse,stat=refuse,fstat=refuse,listdir=refuse,scandir=refuse,system=refuse,popen=refuse,spawnv=refuse,execv=refuse)
  safe_pathlib=types.SimpleNamespace(Path=refuse,PurePosixPath=pathlib.PurePosixPath)
  allowed={'base64':base64,'hashlib':hashlib,'json':json,'os':safe_os,'pathlib':safe_pathlib,'stat':stat,'sys':types.SimpleNamespace(platform='linux',version_info=(3,14))}
  def controlled_import(name,*args,**kwargs):
   imports.append(name)
   if name not in allowed:raise AssertionError('module initialization attempted unapproved import '+name)
   return allowed[name]
  namespace={'__name__':'portable_full_work_product_fixture','__builtins__':{**vars(builtins),'__import__':controlled_import,'open':refuse,'input':refuse}}
  exec(compile(raw,str(SOURCE),'exec'),namespace)
  self.assertEqual(imports,['base64','hashlib','json','os','pathlib','stat','sys']);self.assertEqual(forbidden,[])
  self.assertTrue(callable(namespace['_wf_file_id']));self.assertTrue(callable(namespace['validate_future_runtime33']))
  self.assertEqual(len(namespace['_FIXTURE_PAYLOADS']),2)
 def test_fullwidth_explicitAPI_borrowed_retainedFD(self):
  e,m,n,p=onefile();fd=m.open(p,0);identity=e['_wf_file_id'](fd);self.assertEqual(identity,ident(1));self.assertGreater(int(identity['volumeSerialNumber']),1<<63);self.assertGreater(int(identity['fileId']),1<<64);self.assertEqual(n.handle_calls,[fd]);self.assertEqual(n.queries[0][1:],(18,24));self.assertEqual(len(m.fds),1);self.assertEqual(m.close_attempts,[]);self.assertEqual(len(m.open_calls),1);m.close(fd)
 def test_32bit_ABI_fails_before_library_or_handle(self):
  e,m,n,p=onefile();fd=m.open(p,0);n.bad_pointer=True
  with self.assertRaisesRegex(RuntimeError,'WIN64_REQUIRED'):e['_wf_file_id'](fd)
  self.assertEqual(n.dll_calls,[]);self.assertEqual(n.handle_calls,[]);m.close(fd)
 def test_read_usesNativeID_not_Python_stat_domain(self):
  e,m,n,p=onefile();self.assertNotEqual(str(m.lstat(p).st_dev),ident(1)['volumeSerialNumber']);self.assertEqual(e['_wf_read'](p,5,ident(1),5),b'hello');self.assertEqual(len(n.queries),2);self.assertEqual(len(m.fds),0);self.assertEqual(len(m.close_attempts),1)
 def test_nativeID_mismatch_or_query_failure_closes_before_read(self):
  for failure in ['mismatch','query']:
   e,m,n,p=onefile();n.override_identity=ident(2);n.fail_query=failure=='query'
   with self.subTest(failure=failure),self.assertRaisesRegex(RuntimeError,'WORK_WIN128_ID|WORK_FILE_ID_QUERY'):e['_wf_read'](p,5,ident(1),5)
   self.assertEqual(m.read_calls,0);self.assertEqual(len(m.close_attempts),1);self.assertEqual(len(m.fds),0)
 def test_nativeID_changed_after_read_refuses(self):
  e,m,n,p=onefile();n.sequence=[ident(1),ident(2)]
  with self.assertRaisesRegex(RuntimeError,'WORK_NATIVE_ID_DRIFT'):e['_wf_read'](p,5,ident(1),5)
  self.assertEqual(len(m.close_attempts),1);self.assertEqual(len(m.fds),0)
 def test_first_read_error_survives_cleanup_error_and_standalone_close_surfaces(self):
  e,m,n,p=onefile();first=ValueError('read');cleanup=OSError('close');m.read_error=first;m.close_error=cleanup
  with self.assertRaises(ValueError)as caught:e['_wf_read'](p,5,ident(1),5)
  self.assertIs(caught.exception,first);self.assertEqual(len(m.close_attempts),1);self.assertEqual(len(m.fds),1,'close throw is not called closed')
  e,m,n,p=onefile();m.close_error=cleanup
  with self.assertRaises(OSError)as caught:e['_wf_read'](p,5,ident(1),5)
  self.assertIs(caught.exception,cleanup);self.assertEqual(len(m.fds),1)
 def test_query_error_preserved_when_close_also_fails(self):
  e,m,n,p=onefile();n.fail_query=True;m.close_error=OSError('close')
  with self.assertRaisesRegex(RuntimeError,'WORK_FILE_ID_QUERY'):e['_wf_read'](p,5,ident(1),5)
  self.assertEqual(len(m.close_attempts),1)
 def test_sameFDgeneration_drift_refused(self):
  e,m,n,p=onefile();m.drift=True
  with self.assertRaisesRegex(RuntimeError,'WORK_FD_DRIFT'):e['_wf_read'](p,5,ident(1),5)

class WorkProductTests(unittest.TestCase):
 def test_exact4_nativeIdentity_products_and_closed_runtime33(self):
  e,m,n,ops,records,captured,plan=fixture();rows=e['expected_installation_work_rows']();self.assertEqual(len(rows),4);self.assertEqual(sum(r['relative'].endswith('CopyProof.json')for r in rows),2);result=e['validate_future_runtime33'](plan,m.census(e['E']/'runtime'));self.assertEqual(result['workProductLeaves'],4);self.assertFalse(result['installationAccepted']);self.assertFalse(result['existingFailedReceiptRewritten']);self.assertEqual(len(m.fds),0)
 def test_work_products_query_exact_eight_in_retained_FD_and_native_identity_order(self):
  e,m,n,ops,records,captured,plan=fixture();trace=[];borrow=n.crt.get_osfhandle
  def observed_borrow(fd):
   opened=m.fds[fd];row=m.rows[opened['p']]
   trace.append({'fd':fd,'path':opened['p'],'offset':opened['offset'],'identity':copy.deepcopy(row['identity'])})
   return borrow(fd)
  n.crt.get_osfhandle=observed_borrow
  expected=[]
  for op in ops:
   record=records[op['operationId']];proof_raw=base64.b64decode(record['copyProofBase64']);proof=json.loads(proof_raw);meta=json.loads(record['workerClosedJSON'])['sdk']['copyProof'];base=e['E']/'runtime/local-state/owned-zip-worker-work'/op['operationId'];payload=proof['files'][0]
   for path,size,identity in [(base/'CopyProof.json',len(proof_raw),meta['identity']),(base/'Extract'/payload['path'],payload['bytes'],payload['sourceIdentity'])]:
    expected.extend([{'path':str(path),'offset':0,'identity':identity},{'path':str(path),'offset':size,'identity':identity}])
  rows=e['expected_installation_work_rows']()
  self.assertEqual(len(rows),4);self.assertEqual(len(n.queries),8);self.assertEqual(len(trace),8)
  self.assertEqual([{k:v for k,v in row.items()if k!='fd'}for row in trace],expected)
  self.assertEqual(n.queries,[((1<<36)+row['fd'],18,24)for row in trace])
  self.assertEqual(n.handle_calls,[row['fd']for row in trace])
  self.assertEqual(len({row['fd']for row in trace}),4)
  for index in range(0,8,2):
   self.assertEqual(trace[index]['fd'],trace[index+1]['fd'],'pre/post native identity must use the same retained FD')
   self.assertEqual(m.close_attempts.count(trace[index]['fd']),1,'only the owning FD scope closes once')
  self.assertEqual(len(m.open_calls),6,'two capture/proof/payload opens; native observation must not reopen a path')
  self.assertEqual(len(m.close_attempts),6);self.assertEqual(m.fds,{})
 def test_copyproof_native_identity_mismatch_refuses_in_either_operation(self):
  for index in [0,1]:
   e,m,n,ops,records,captured,plan=fixture();path=e['E']/'runtime/local-state/owned-zip-worker-work'/ops[index]['operationId']/'CopyProof.json';original=m.rows[str(path)]['data'];m.rows[str(path)]['identity']=ident(999)
   with self.subTest(operation=index),self.assertRaisesRegex(RuntimeError,'WORK_WIN128_ID'):e['expected_installation_work_rows']()
   self.assertEqual(m.rows[str(path)]['data'],original,'equal proof bytes do not replace native identity')
   self.assertEqual(len(n.queries),index*4+1,'refusal must occur on CopyProof pre-read native query')
   self.assertEqual(m.fds,{})
 def test_extra_empty_worktree_or_nested_directory_rejected(self):
  for mode in ['op','nested']:
   e,m,n,ops,records,captured,plan=fixture();base=e['E']/'runtime/local-state/owned-zip-worker-work';p=base/'op_unknown'if mode=='op'else base/ops[0]['operationId']/'ExtraEmpty';m.directory(p)
   with self.subTest(mode=mode),self.assertRaisesRegex(RuntimeError,'WORK_EXACT_TWO_ROOTS|WORK_EXACT_DIRECTORY_INVENTORY'):e['expected_installation_work_rows']()
 def test_extra_file_missing_payload_reparse_and_hardlink_refused(self):
  for mode in ['extra','missing','reparse','hardlink']:
   e,m,n,ops,records,captured,plan=fixture();base=e['E']/'runtime/local-state/owned-zip-worker-work'/ops[0]['operationId'];file=base/'Extract/archive/pc/mod/NexusFixtureCancelOne.archive'
   if mode=='extra':m.file(base/'unselected.bin',b'x')
   if mode=='missing':del m.rows[str(file)]
   if mode=='reparse':m.rows[str(base)]['reparse']=True
   if mode=='hardlink':m.rows[str(file)]['nlink']=2
   with self.subTest(mode=mode),self.assertRaises((RuntimeError,KeyError)):e['expected_installation_work_rows']()
 def test_physical_proof_or_payload_bytes_and_fullidentity_mismatch_refuse(self):
  for mode in ['proof','payload','native']:
   e,m,n,ops,records,captured,plan=fixture();base=e['E']/'runtime/local-state/owned-zip-worker-work'/ops[0]['operationId'];p=base/'CopyProof.json'if mode=='proof'else base/'Extract/archive/pc/mod/NexusFixtureCancelOne.archive'
   if mode=='native':m.rows[str(p)]['identity']=ident(999)
   else:raw=m.rows[str(p)]['data'];m.rows[str(p)]['data']=bytes([raw[0]^1])+raw[1:]
   with self.subTest(mode=mode),self.assertRaises(RuntimeError):e['expected_installation_work_rows']()
 def test_immutable17_foreign_prefix_and_global_empty_directory_refuse(self):
  for mode in ['immutable','file','empty']:
   e,m,n,ops,records,captured,plan=fixture();runtime=e['E']/'runtime'
   if mode=='immutable':m.rows[str(runtime/'tools/module-0')]['data']=b'bad'
   if mode=='file':m.file(runtime/'local-state/owned-zip-worker-work/foreign.txt',b'bad')
   if mode=='empty':m.directory(runtime/'local-state/extra-empty')
   with self.subTest(mode=mode),self.assertRaises(RuntimeError):e['validate_future_runtime33'](plan,m.census(runtime))
 def test_case_alias_not_blanket_prefix_ignored(self):
  e,m,n,ops,records,captured,plan=fixture();current=m.census(e['E']/'runtime');current.append({**current[0],'relative':current[0]['relative'].upper()})
  with self.assertRaisesRegex(RuntimeError,'WORK_GLOBAL_ALIAS'):e['validate_future_runtime33'](plan,sorted(current,key=lambda r:r['relative']))

 def test_V2_accepts_global_hardlinks_V3_refuses_fixed17_and_journal12(self):
  for target in ['fixed','journal']:
   for variant in ['v2','v3']:
    e,m,n,ops,records,captured,plan=fixture(variant);runtime=e['E']/'runtime'
    p=runtime/'tools/module-0'if target=='fixed'else runtime/'local-state/vortex-agent-build/native-install-executor/operations/unit-0/intent.json';m.rows[str(p)]['nlink']=2
    current=m.census(runtime);self.assertEqual(len(current),33,'metadata facade still hashes all files; no nlink authority')
    with self.subTest(target=target,variant=variant):
     if variant=='v2':self.assertEqual(e['validate_future_runtime33'](plan,current)['workProductLeaves'],4)
     else:
      with self.assertRaisesRegex(RuntimeError,'WORK_RUNTIME_ORDINARY_SINGLE_LINK_SIZE'):e['validate_future_runtime33'](plan,current)

if __name__=='__main__':unittest.main()
