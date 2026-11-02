# FUTURE READ-ONLY supervisor fragment. No SDK/addon/DB/app execution;
# explicit readonly kernel32 FileIdInfo on retained own FDs is permitted.
# Caller supplies existing globals/functions E,CUSTODY,execution_bindings,
# execution_capture,census,need. No public endpoint or filesystem writes.
import base64,hashlib,json,os,pathlib,stat,sys

_FIXTURE_PAYLOADS={
 'FixtureCancelOne':('FGW2iMsG4g','FixtureCancelOne.zip','archive/pc/mod/NexusFixtureCancelOne.archive',55,'0646435d0a7ba2dabb166ff3d125f6efd4eb711754c777863942cc1ed673cdac'),
 'FixtureCancelTwo':('XJt8-wN3Q','FixtureCancelTwo.zip','archive/pc/mod/NexusFixtureCancelTwo.archive',55,'78a98f968f51016f5ba4c7e69febcbaba8646df4c1a25c50d63ef70ba4b25208')}

def _wf_file_id(fd):
 # Borrow the native HANDLE of this already-owned open FD; never open a path or
 # independently close the borrowed HANDLE. Only the FD scope owns cleanup.
 import ctypes as C
 import msvcrt
 need(os.name=='nt'and C.sizeof(C.c_void_p)==8 and C.sizeof(C.c_int)==4 and C.sizeof(C.c_uint32)==4 and C.sizeof(C.c_uint64)==8,'WORK_FILE_ID_WIN64_REQUIRED')
 class FILE_ID_128(C.Structure):_fields_=[('Identifier',C.c_ubyte*16)]
 class FILE_ID_INFO(C.Structure):_fields_=[('VolumeSerialNumber',C.c_uint64),('FileId',FILE_ID_128)]
 need(C.sizeof(FILE_ID_128)==16 and C.sizeof(FILE_ID_INFO)==24 and FILE_ID_INFO.FileId.offset==8,'WORK_FILE_ID_ABI')
 handle=msvcrt.get_osfhandle(fd);need(type(handle)is int and handle not in(-1,0),'WORK_FILE_ID_HANDLE')
 api=C.WinDLL('kernel32.dll',use_last_error=True).GetFileInformationByHandleEx
 api.argtypes=[C.c_void_p,C.c_int,C.c_void_p,C.c_uint32];api.restype=C.c_int
 info=FILE_ID_INFO();need(api(C.c_void_p(handle),18,C.byref(info),C.sizeof(info))!=0,'WORK_FILE_ID_QUERY')
 return {'schema':'win-file-id128/1','volumeSerialNumber':str(info.VolumeSerialNumber),'fileId':str(int.from_bytes(bytes(info.FileId.Identifier),'little'))}
def _wf_gen(s):return(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns,s.st_nlink,s.st_mode,getattr(s,'st_file_attributes',0))
def _wf_shared(s):return(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_nlink,s.st_mode&~0o111 if os.name=='nt'else s.st_mode)
def _wf_plain(s,directory):need(not stat.S_ISLNK(s.st_mode)and not(getattr(s,'st_file_attributes',0)&0x400)and(stat.S_ISDIR(s.st_mode)if directory else stat.S_ISREG(s.st_mode)),'WORK_REPARSE_OR_TYPE')
def _wf_dirs(p):
 rows=[]
 for q in [p,*p.parents]:s=os.lstat(q);_wf_plain(s,True);rows.append((q,_wf_gen(s)))
 return rows

def _wf_read(path,cap,identity=None,exact_size=None):
 path=pathlib.Path(path);parents=_wf_dirs(path.parent);before=os.lstat(path);_wf_plain(before,False)
 need(before.st_nlink==1 and 0<=before.st_size<=cap and(exact_size is None or before.st_size==exact_size),'WORK_FILE_BOUND')
 fd=os.open(path,os.O_RDONLY|getattr(os,'O_BINARY',0)|getattr(os,'O_NOINHERIT',0)|getattr(os,'O_NOFOLLOW',0));failed=False;primary=None;raw=None
 try:
  opened=os.fstat(fd);_wf_plain(opened,False);need(_wf_shared(opened)==_wf_shared(before),'WORK_PATH_FD_DRIFT')
  if identity is not None:need(type(identity)is dict and set(identity)=={'schema','volumeSerialNumber','fileId'}and identity['schema']=='win-file-id128/1'and _wf_file_id(fd)==identity,'WORK_WIN128_ID')
  chunks=[];used=0
  while used<=before.st_size:
   chunk=os.read(fd,min(65536,before.st_size-used+1))
   if not chunk:break
   used+=len(chunk);need(used<=before.st_size,'WORK_FILE_GREW');chunks.append(chunk)
  need(used==before.st_size and _wf_gen(os.fstat(fd))==_wf_gen(opened),'WORK_FD_DRIFT');raw=b''.join(chunks)
  if identity is not None:need(_wf_file_id(fd)==identity,'WORK_NATIVE_ID_DRIFT')
 except BaseException as error:failed=True;primary=error
 try:os.close(fd)
 except BaseException as error:
  if not failed:failed=True;primary=error
 if failed:raise primary
 need(_wf_gen(os.lstat(path))==_wf_gen(before),'WORK_PATH_DRIFT')
 for directory,generation in parents:need(_wf_gen(os.lstat(directory))==generation,'WORK_ANCESTRY_DRIFT')
 return raw

def _wf_json(raw):
 value=json.loads(raw.decode('utf8'));need(json.dumps(value,separators=(',',':'),ensure_ascii=False).encode()==raw,'WORK_CAPTURE_CANONICAL_JSON');return value

def _wf_canonical_path(text):
 need(type(text)is str and text and not any(ord(c)<32 for c in text),'WORK_OBSERVATION_PATH')
 parts=text.replace('\\','/').split('/');need(all(p not in ['.','..']for p in parts),'WORK_OBSERVATION_DOTSEGMENT')
 return os.path.normcase(os.path.normpath(text))

def expected_installation_work_rows():
 cfg,v=execution_bindings();operations=v['rootDecision']['newOperations'];need(len(operations)==2,'WORK_EXACT_TWO_OPERATIONS');runtime=E/'runtime';base=runtime/'local-state/owned-zip-worker-work';expected=[];seen_mods=set()
 # Whole operation-scope census witnesses directory names/types/generations and
 # hash bytes; do not use a blanket prefix exclusion in the caller.
 for operation in operations:
  op=operation['operationId'];need(type(op)is str and op.startswith('op_')and len(op)==35 and all(c in '0123456789abcdef'for c in op[3:]),'WORK_OPERATION_LABEL')
  capture_file=CUSTODY/(op+'.json');validated=execution_capture(capture_file,operation);capture_raw=_wf_read(capture_file,8388608);need(hashlib.sha256(capture_raw).hexdigest()==validated['captureSHA256'],'WORK_CAPTURE_READBACK_STABLE');record=_wf_json(capture_raw.rstrip(b'\n'))
  need(record['binding']==validated['binding'],'WORK_CAPTURE_STABLE_BINDING');binding=record['binding'];request_raw=base64.b64decode(record['requestBase64'],validate=True)
  need(0<len(request_raw)<=1052672 and base64.b64encode(request_raw).decode()==record['requestBase64']and hashlib.sha256(request_raw).hexdigest()==binding['requestBytesSHA256'],'WORK_EFFECTIVE_REQUEST_BYTES')
  request=_wf_json(request_raw);need(request['schema']=='native-dispatch-request/1'and request['contractId']=='tracked-new-disabled-dispatch/1'and all(request[k]==binding[k]for k in ['operationId','nativeJobId','rendererGeneration','managerScope']),'WORK_REQUEST_TUPLE')
  plan=request['plan'];package=plan['package'];mod=package['expectedModId'];need(mod in _FIXTURE_PAYLOADS and mod not in seen_mods and mod==binding['modId']and plan['family']=='tracked-new-disabled'and plan['options']['enabled']is False and plan['options']['deploy']is False,'WORK_FIXTURE_SCOPE');seen_mods.add(mod)
  download,archive,member,size,payload_hash=_FIXTURE_PAYLOADS[mod]
  need(package['downloadId']==download and package['fileName']==archive and package['payload']=={member:payload_hash}and package['expectedUncompressedBytes']==size,'WORK_EXPECTED_PLAN_PAYLOAD')
  proof_raw=base64.b64decode(record['copyProofBase64'],validate=True);need(0<len(proof_raw)<=4194304 and base64.b64encode(proof_raw).decode()==record['copyProofBase64'],'WORK_PROOF_BYTES_BOUND')
  proof=json.loads(proof_raw.decode('utf8'));need(json.dumps(proof,separators=(',',':'),ensure_ascii=True,sort_keys=True).encode()==proof_raw,'WORK_PYTHON_CANONICAL_PROOF')
  prepared=json.loads(record['preparedJSON']);closed=json.loads(record['workerClosedJSON']);sdk=closed['sdk'];worker=sdk['worker'];held=json.loads(record['ownershipHoldJSON']);meta=sdk['copyProof']
  need(closed['phase']=='released'and sdk['phase']=='released'and sdk['childClosed']is True and worker['phase']=='released'and worker['errorCode']is None,'WORK_CLOSED_ONLY')
  expected_binding={k:binding[k]for k in ['operationId','nativeJobId','requestSHA256','rendererGeneration']}
  need(proof['schema']=='owned-zip-copy-proof/1'and proof['binding']==expected_binding and proof['workerLifetime']==prepared['workerLifetime']and proof['packetSHA256']==prepared['packetSHA256']and proof['copiedFiles']==1 and proof['totalBytes']==size and len(proof['files'])==1,'WORK_PROOF_BINDING')
  row=proof['files'][0];need(set(row)=={'path','bytes','sha256','sourceIdentity','destinationIdentity'}and row['path']==member and row['bytes']==size and row['sha256']==payload_hash,'WORK_PROOF_PAYLOAD')
  need(proof['effectsAllowed']is False and proof['nativeInstallAccepted']is False and proof['persistenceVerified']is False,'WORK_NO_PERMISSION')
  need(proof['destination']==sdk['destination']==worker['destination']and proof['destination']['leaf']==mod and _wf_canonical_path(proof['destination']['parent'])==_wf_canonical_path(str(E/'staging')),'WORK_DESTINATION_BINDING')
  digest=hashlib.sha256(proof_raw).hexdigest();need(meta==worker['copyProof']and meta['bytes']==len(proof_raw)and meta['sha256']==digest==held['copyProofSHA256']and meta['files']==1 and meta['totalBytes']==size,'WORK_SDK_PROOF_METADATA')
  op_root=base/op;need(_wf_canonical_path(worker['workRoot'])==_wf_canonical_path(str(op_root)),'WORK_ROOT_COMPUTED_NOT_CLAIMED')
  physical_proof=_wf_read(op_root/'CopyProof.json',4194304,meta['identity'],len(proof_raw));need(physical_proof==proof_raw,'WORK_PROOF_RAW_EQUALITY')
  relative=pathlib.PurePosixPath(member);need(relative.as_posix()==member and not relative.is_absolute()and all(p not in ['.','..','']for p in member.split('/')),'WORK_MEMBER_PATH')
  payload_path=op_root/'Extract'
  for component in relative.parts:payload_path=payload_path/component
  payload=_wf_read(payload_path,size,row['sourceIdentity'],size);need(hashlib.sha256(payload).hexdigest()==payload_hash,'WORK_EXTRACT_PAYLOAD_SHA')
  expected.extend([{'relative':(op_root/'CopyProof.json').relative_to(runtime).as_posix(),'bytes':len(proof_raw),'sha256':digest},{'relative':payload_path.relative_to(runtime).as_posix(),'bytes':size,'sha256':payload_hash}])
 need(len(seen_mods)==2 and len(expected)==4,'WORK_EXACT_FOUR_FILES')
 expected=sorted(expected,key=lambda r:r['relative']);actual=census(base);prefix='local-state/owned-zip-worker-work/'
 need([{'relative':prefix+r['relative'],'bytes':r['bytes'],'sha256':r['sha256']}for r in actual]==expected,'WORK_ONLY_EXPECTED_FOUR_LEAVES')
 # Refuse even unselected empty directories: files alone are insufficient.
 dirs={base}
 for row in expected:
  p=runtime/row['relative']
  while p.parent!=base and p.parent!=p:dirs.add(p.parent);p=p.parent
 need({p.name for p in base.iterdir()}=={op['operationId']for op in operations},'WORK_EXACT_TWO_ROOTS')
 for directory in dirs:
  _wf_dirs(directory);wanted={p.name for p in dirs if p.parent==directory}|{(runtime/r['relative']).name for r in expected if(runtime/r['relative']).parent==directory}
  need({p.name for p in directory.iterdir()}==wanted,'WORK_EXACT_DIRECTORY_INVENTORY')
 return expected


def _wf_exact_runtime_directories(runtime,rows):
 dirs={runtime};files={runtime/r['relative']for r in rows}
 leaves=[]
 for row in rows:
  file=runtime/row['relative'];sample=os.lstat(file);_wf_plain(sample,False)
  need(sample.st_nlink==1 and sample.st_size==row['bytes'],'WORK_RUNTIME_ORDINARY_SINGLE_LINK_SIZE');leaves.append((file,_wf_gen(sample)))
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
 for file,generation in leaves:need(_wf_gen(os.lstat(file))==generation,'WORK_RUNTIME_END_LEAF_DRIFT')
def validate_future_runtime33(plan,current):
 # Future post-completion guard only. Existing failed result is NEVER rewritten.
 runtime=E/'runtime';journal_prefix='local-state/vortex-agent-build/native-install-executor/'
 sealed=plan['runtimeFiles'];need(len(sealed)==23,'WORK_PRESTART23_C2_BASELINE')
 base17=[r for r in sealed if not r['relative'].startswith(journal_prefix)];need(len(base17)==17,'WORK_BASE17')
 current_map={r['relative']:r for r in current};need(len(current_map)==len(current)and len({p.casefold()for p in current_map})==len(current_map),'WORK_GLOBAL_ALIAS')
 for row in base17:need(current_map.get(row['relative'])==row,'WORK_IMMUTABLE17')
 journal=journal_layout();need(len(journal)==12,'WORK_EXISTING_FINAL_JOURNAL12')
 journal_rows=[{'relative':journal_prefix+r['relative'],'bytes':r['bytes'],'sha256':r['sha256']}for r in journal]
 work=expected_installation_work_rows();all_expected=sorted(base17+journal_rows+work,key=lambda r:r['relative']);need(len(all_expected)==33 and current==all_expected,'WORK_CLOSED_RUNTIME33_ONLY');_wf_exact_runtime_directories(runtime,all_expected)
 return {'schema':'own-future-runtime-work-products-observed/1','immutableRuntimeLeaves':17,'journalLeaves':12,'workProductLeaves':4,'workProducts':work,'priorC2Preserved':True,'existingFailedReceiptRewritten':False,'installationAccepted':False,'effectsAllowed':False,'installationPermit':False,'nativeAdmission':False}
