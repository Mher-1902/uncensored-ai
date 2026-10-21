"""Run on isolated Samsung ONLY. Metadata mapping + rowwise reference comparisons; no inference."""
from fixture_guard import require_fixture
require_fixture()
import importlib,io,json,struct,sys,types
from pathlib import Path
import numpy as np
from hybrid_mapping import compile_manifest
from quant_layout import q4k_to_mnn,q5k_to_exact_mnn8,q6k_to_exact_mnn8,write_matrix,mnn_header
# Load only the pinned pure-Python GGUF reader/quants, without package-wide optional exports.
package=types.ModuleType('gguf');package.__path__=['/reference/gguf'];sys.modules['gguf']=package
from gguf.constants import GGMLQuantizationType
from gguf.quants import dequantize
x=json.loads(Path('/input/graph-ops.json').read_text())
manifest=compile_manifest(x,{'tensors':x['gguf_tensors']})
# Parse descriptor offsets without materializing248k tokenizer array objects.
with open('/models/model.gguf','rb') as f:
    def scalar(fmt):
        n=struct.calcsize('<'+fmt);data=f.read(n);assert len(data)==n
        return struct.unpack('<'+fmt,data)[0]
    def string():
        n=scalar('Q');assert n<1048576;return f.read(n).decode()
    sizes={0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8}
    def skip(kind):
        if kind in sizes:f.seek(sizes[kind],1)
        elif kind==8:f.seek(scalar('Q'),1)
        elif kind==9:
            item=scalar('I');count=scalar('Q');assert count<1000000 and item!=9
            if item in sizes:f.seek(count*sizes[item],1)
            else:
                for _ in range(count):skip(item)
        else:raise ValueError('metadata_type')
    assert f.read(4)==b'GGUF' and scalar('I')==3
    count=scalar('Q');metadata=scalar('Q');alignment=32
    for _ in range(metadata):
        key=string();kind=scalar('I')
        if key=='general.alignment':assert kind==4;alignment=scalar('I')
        else:skip(kind)
    tensors=[]
    for _ in range(count):
        name=string();nd=scalar('I');assert nd<5
        shape=[scalar('Q') for _ in range(nd)];kind=scalar('I');offset=scalar('Q')
        tensors.append({'name':name,'shape':shape,'type':kind,'offset':offset})
    assert tensors==x['gguf_tensors'] and alignment in [32,64,128,256]
    data_start=((f.tell()+alignment-1)//alignment)*alignment
by_name={t['name']:types.SimpleNamespace(name=t['name'],shape=t['shape'],tensor_type=t['type'],data_offset=data_start+t['offset']) for t in tensors}
reports=[];written_types=set()
assert len(by_name)==320

def decode(codes,alpha,kind):
    if kind==12:
        q=np.frombuffer(codes,dtype=np.uint8)
        q=np.stack([q>>4,q&15],axis=1).reshape(-1,8,32).astype(np.int16)-8
        a=np.frombuffer(alpha,dtype='<f4').reshape(-1,8,2)
        return (q*a[:,:,1,None]+a[:,:,0,None]).reshape(-1)
    if kind==13:
        q=np.frombuffer(codes,dtype=np.uint8).reshape(-1,8,32).astype(np.int16)-128
        a=np.frombuffer(alpha,dtype='<f4').reshape(-1,8,2)
        return (q*a[:,:,1,None]+a[:,:,0,None]).reshape(-1)
    q=np.frombuffer(codes,dtype=np.uint8).reshape(-1,16,16).astype(np.int16)-128
    a=np.frombuffer(alpha,dtype='<f4').reshape(-1,16)
    return (q*a[:,:,None]).reshape(-1)

codecs={12:(144,q4k_to_mnn),13:(176,q5k_to_exact_mnn8),14:(210,q6k_to_exact_mnn8)}
for entry in manifest['mapping_entries']:
    if entry['op_type']!='Convolution':continue
    t=by_name[entry['source']];kind=int(t.tensor_type);assert kind in codecs
    ic,oc=map(int,t.shape);block_bytes,codec=codecs[kind];row_bytes=ic//256*block_bytes
    data=np.memmap('/models/model.gguf',mode='r',offset=t.data_offset,dtype=np.uint8,shape=(oc*row_bytes,))
    max_error=0.0
    for row in sorted({0,oc//2,oc-1}):
        raw=data[row*row_bytes:(row+1)*row_bytes].tobytes();codes,alpha=codec(raw)
        reference=dequantize(np.frombuffer(raw,dtype=np.uint8).reshape(-1,block_bytes),GGMLQuantizationType(kind)).reshape(-1)
        got=decode(codes,alpha,kind);assert len(got)==len(reference)==ic
        np.testing.assert_allclose(got,reference,rtol=2e-6,atol=2e-7,err_msg=entry['source'])
        max_error=max(max_error,float(np.max(np.abs(got-reference))))
    if kind not in written_types:
        memory=io.BytesIO()
        with open('/models/model.gguf','rb') as raw_reader:
            info=write_matrix(raw_reader,memory,source_offset=int(t.data_offset),ic=ic,oc=3,gguf_type=kind,rows_per_chunk=2)
        blob=memory.getvalue();start,weight_len,alpha_len,bias_len,_=info['external']
        bits=info['quanParameter']['aMaxOrBits'];header,int32=mnn_header(ic,3,bits)
        assert start==0 and blob.startswith(header) and len(blob)==weight_len+alpha_len+bias_len
        assert blob[-bias_len:]==b'\x00'*bias_len
        got=decode(blob[len(header):weight_len],blob[weight_len:weight_len+alpha_len],kind)
        reference=dequantize(data[:3*row_bytes].reshape(-1,block_bytes),GGMLQuantizationType(kind)).reshape(-1)
        np.testing.assert_allclose(got,reference,rtol=2e-6,atol=2e-7)
        written_types.add(kind)
    reports.append({'tensor':entry['source'],'kind':kind,'rows':3,'max_abs_error':max_error})
assert len(reports)==187 and written_types=={12,13,14}
assert mnn_header(2048,248320,8)[1] is True
result={'source_coverage':manifest['source_coverage'],'matrix_ops':len(reports),'row_comparisons':sum(r['rows'] for r in reports),'maximum_abs_error':max(r['max_abs_error'] for r in reports),'quant_types':sorted({r['kind'] for r in reports}),'structural_constants':manifest['remaining_structural_constants'],'model_loaded':False,'converted':False,'production_changed':False,'per_matrix':reports}
Path('/output/codec-validation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['per_matrix','structural_constants']}),flush=True)
