"""Private CPU layout experiment: only existing Q4_K tensors change format.

The Q4_0 values come directly from the pinned BF16 checkpoint. Every other
learned tensor is copied byte-for-byte from the serving GGUF. No user content.
"""
from fixture_guard import require_fixture
require_fixture()
from pathlib import Path
import hashlib,json,math,os,re,struct,subprocess,time
from gguf_layout import layout

def digest(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as f:
  for data in iter(lambda:f.read(1048576),b''):h.update(data)
 return h.hexdigest()

def header(path):
 """Read only bounded GGUF metadata records and its tensor-table boundary."""
 with Path(path).open('rb') as f:
  def scalar(fmt):
   size=struct.calcsize('<'+fmt);raw=f.read(size);assert len(raw)==size
   return struct.unpack('<'+fmt,raw)[0]
  def string():
   n=scalar('Q');assert n<1048576;raw=f.read(n);assert len(raw)==n
   return raw.decode()
  sizes={0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8}
  def skip(kind):
   if kind in sizes:f.seek(sizes[kind],1)
   elif kind==8:
    n=scalar('Q');assert n<1048576;f.seek(n,1)
   elif kind==9:
    item=scalar('I');count=scalar('Q');assert count<=1000000 and item!=9
    if item in sizes:f.seek(count*sizes[item],1)
    else:
     for _ in range(count):skip(item)
   else:raise ValueError('Unsupported metadata type')
  assert f.read(4)==b'GGUF' and scalar('I')==3
  assert scalar('Q')==320;nmeta=scalar('Q');assert nmeta<1000
  fields={};locations={}
  for _ in range(nmeta):
   key=string();assert key not in fields;start=f.tell();kind=scalar('I');skip(kind);end=f.tell();assert end<=16777216
   locations[key]={'offset':start,'kind':kind};f.seek(start);fields[key]=hashlib.sha256(f.read(end-start)).hexdigest();f.seek(end)
  end=f.tell();f.seek(0);return f.read(end),fields,locations

def nbytes(t):
 blocks={0:(1,4),1:(1,2),2:(32,18),12:(256,144),13:(256,176),14:(256,210),30:(1,2)}
 count=math.prod(t['shape']);block,size=blocks[t['type']];assert count%block==0
 return count//block*size

assert Path('/sys/fs/cgroup/memory.swap.max').read_text().strip()=='0'
assert int(Path('/sys/fs/cgroup/memory.max').read_text())<=1024**3
assert sorted(p.name for p in Path('/sys/class/net').iterdir())==['lo']
assert digest('/selected/model.gguf')=='be3ccca13a9d1bc8b67165ea80bd103cd6151a37ad131183cc7ca388f78d9517'
assert digest('/bf16/model.gguf')=='d98cff5f907e2186ac8243ac5676a47dc24e1822cd6ed674c9c92c7503915a1b'
assert digest('/quantizer/llama-quantize')=='e48ccc3b8f05e0b7bf3507f40acf0a1f68089bd0562b76b77c2aeeb6028f7a65'
old,start_old,md_old=layout('/selected/model.gguf');bf,start_bf,md_bf=layout('/bf16/model.gguf')
a={t['name']:t for t in old};b={t['name']:t for t in bf};assert a.keys()==b.keys()
assert all(a[k]['shape']==b[k]['shape'] for k in a)
assert {t['type']:sum(v['type']==t['type'] for v in old) for t in old}=={0:133,12:152,13:18,14:17}
old_header,before_meta,old_locations=header('/selected/model.gguf');_,bf_meta,_=header('/bf16/model.gguf')
assert {k:v for k,v in before_meta.items() if k.startswith('tokenizer.')}=={k:v for k,v in bf_meta.items() if k.startswith('tokenizer.')}
assert md_old['general.architecture']==md_bf['general.architecture']=='qwen35'
output=Path('/output');intermediate=output/'intermediate.gguf';final=output/'model.gguf';assert not intermediate.exists() and not final.exists()
types={0:'f32',1:'f16',30:'bf16'}
rules=[]
for name in a:
 target='q4_0' if a[name]['type']==12 else types[b[name]['type']]
 rules.append('^'+re.escape(name)+'$='+target)
(output/'tensor-types.txt').write_text('\n'.join(rules)+'\n')
start=time.monotonic()
with (output/'quantize.log').open('w') as log:
 subprocess.run(['/quantizer/llama-quantize','--tensor-type-file','/output/tensor-types.txt','/bf16/model.gguf',str(intermediate),'Q4_0','2'],env={'PATH':'/usr/bin:/bin','HOME':'/tmp','TMPDIR':'/tmp','LD_LIBRARY_PATH':'/quantizer'},stdout=log,stderr=subprocess.STDOUT,check=True,timeout=800)
quantized,quant_start,quant_md=layout(intermediate);q={t['name']:t for t in quantized};assert q.keys()==a.keys()
assert all(q[k]['shape']==a[k]['shape'] for k in a)
assert all(q[k]['type']==(2 if a[k]['type']==12 else b[k]['type']) for k in a)

_,quant_meta,_=header(intermediate)
assert {k:v for k,v in quant_meta.items() if k.startswith('tokenizer.')}=={k:v for k,v in before_meta.items() if k.startswith('tokenizer.')}
# Q4_K and Q4_0 both occupy144 bytes per256 values. Patch only those
# tensor descriptors/payloads in an exact copy of the serving GGUF. This
# preserves every tokenizer field, geometry field and other learned byte.
partial=output/'model.gguf.partial';assert not partial.exists()
with open('/selected/model.gguf','rb') as src,partial.open('xb') as out:
 os.chmod(partial,0o600)
 for chunk in iter(lambda:src.read(1048576),b''):out.write(chunk)
assert digest(partial)=='be3ccca13a9d1bc8b67165ea80bd103cd6151a37ad131183cc7ca388f78d9517'
positions={};cursor=len(old_header)
for t in old:
 cursor+=8+len(t['name'].encode())+4+8*len(t['shape']);positions[t['name']]=cursor;cursor+=12
assert ((cursor+md_old.get('general.alignment',32)-1)//md_old.get('general.alignment',32)*md_old.get('general.alignment',32))==start_old
records=[]
with partial.open('r+b') as out,intermediate.open('rb') as new:
 ftype=old_locations['general.file_type'];assert ftype['kind']==4 and md_old['general.file_type']==15
 out.seek(ftype['offset']+4);out.write(struct.pack('<I',2))
 for t in old:
  if t['type']!=12:continue
  replacement=q[t['name']];assert replacement['type']==2 and nbytes(replacement)==nbytes(t)
  out.seek(positions[t['name']]);assert out.read(4)==struct.pack('<I',12);out.seek(positions[t['name']]);out.write(struct.pack('<I',2))
  new.seek(quant_start+replacement['offset']);out.seek(start_old+t['offset']);remaining=nbytes(t)
  while remaining:
   chunk=new.read(min(1048576,remaining));assert chunk;out.write(chunk);remaining-=len(chunk)
 out.flush();os.fsync(out.fileno())
check,check_start,check_md=layout(partial);assert check_start==start_old
assert check==[{**t,'type':2 if t['type']==12 else t['type']} for t in old]
_,check_meta,_=header(partial)
assert {k:v for k,v in check_meta.items() if k!='general.file_type'}=={k:v for k,v in before_meta.items() if k!='general.file_type'}
assert check_md['general.file_type']==2
# Independently read back every protected tensor from both complete files.
with open('/selected/model.gguf','rb') as src,partial.open('rb') as out:
 for t in old:
  if t['type']==12:continue
  size=nbytes(t);source_hash=hashlib.sha256();target_hash=hashlib.sha256()
  src.seek(start_old+t['offset']);out.seek(start_old+t['offset']);remaining=size
  while remaining:
   take=min(1048576,remaining);left=src.read(take);right=out.read(take);assert len(left)==len(right)==take
   source_hash.update(left);target_hash.update(right);remaining-=take
  assert source_hash.digest()==target_hash.digest()
  records.append({'name':t['name'],'type':t['type'],'bytes':size,'payload_sha256':target_hash.hexdigest()})
assert len(records)==168 and partial.stat().st_size==1270808032
partial.rename(final)
receipt={'complete':True,'selected_source_sha256':'be3ccca13a9d1bc8b67165ea80bd103cd6151a37ad131183cc7ca388f78d9517','bf16_source_sha256':'d98cff5f907e2186ac8243ac5676a47dc24e1822cd6ed674c9c92c7503915a1b','candidate_sha256':digest(final),'candidate_bytes':final.stat().st_size,'changed_q4_tensors':152,'unchanged_tensors':168,'protected_tensor_readback_verified':True,'tokenizer_metadata_identical':True,'double_quantization':False,'quantize_and_copy_s':time.monotonic()-start,'protected_tensor_receipts':records,'model_loaded':False,'quality_assessed':False,'activated':False}
(output/'artifact.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:v for k,v in receipt.items() if k!='protected_tensor_receipts'}),flush=True)
