"""Private Samsung-only exact-checkpoint conversion. No inference/network/serving changes."""
from fixture_guard import require_fixture
require_fixture()
from pathlib import Path
import hashlib,json,math,os,time
import numpy as np
from gguf_layout import layout
from hybrid_mapping import compile_manifest
from quant_layout import write_matrix
from MNN.tools import mnnconvert

model=Path('/models/model.gguf');output=Path('/output');graph_file=Path('/graph/llm.mnn')
assert model.stat().st_size==1270808032
assert hashlib.sha256(graph_file.read_bytes()).hexdigest()=='23df98f8b341b277365e0bbca025c1d192939e3d32d7f79776352c6f32e77960'
h=hashlib.sha256()
with model.open('rb') as f:
    for part in iter(lambda:f.read(1048576),b''):h.update(part)
assert h.hexdigest()=='be3ccca13a9d1bc8b67165ea80bd103cd6151a37ad131183cc7ca388f78d9517'
expected=json.loads(Path('/input/graph-ops.json').read_text())
tensors,data_start,metadata=layout(model);assert tensors==expected['gguf_tensors']
assert metadata['general.architecture']=='qwen35'
assert metadata['qwen35.rope.dimension_count']==64 and metadata['qwen35.rope.freq_base']==10000000
mnnconvert.convert(['','-f','MNN','--modelFile',str(graph_file),'--JsonFile','/tmp/original.json'])
graph=json.loads(Path('/tmp/original.json').read_text())
assert graph['oplists']==expected['oplists'] and graph['tensorName']==expected['tensorName']
assert not graph.get('subgraphs')
manifest=compile_manifest(graph,{'tensors':tensors})
assert manifest['remaining_structural_constants']==json.loads(Path('/input/structural-constants.json').read_text())
ops={(o['type'],o['name']):o for o in graph['oplists']};inventory={t['name']:t for t in tensors}
weight_path=output/'llm.mnn.weight.partial';assert not weight_path.exists()
records=[];tie=None;started=time.monotonic()
with model.open('rb') as reader,weight_path.open('xb') as writer:
    for index,entry in enumerate(manifest['mapping_entries']):
        op=ops[entry['op_type'],entry['op_name']];main=op['main'];tensor=inventory[entry['source']]
        offset=data_start+tensor['offset'];shape=tensor['shape']
        if op['type']=='Convolution':
            ic,oc=shape;assert main['common']['inputCount']==ic and main['common']['outputCount']==oc
            replacement=write_matrix(reader,writer,source_offset=offset,ic=ic,oc=oc,gguf_type=tensor['type'])
            for key in ['weight','bias','quanParameter','external','symmetricQuan']:main.pop(key,None)
            main['quanParameter']=replacement['quanParameter'];main['external']=replacement['external']
            if entry['source']=='token_embd.weight':tie=replacement['tie_embeddings']
            records.append({**entry,'source_type':tensor['type'],'external':main['external']})
        else:
            assert tensor['type']==0
            count=math.prod(shape);assert count<=24576
            reader.seek(offset);raw=reader.read(count*4);assert len(raw)==count*4
            values=np.frombuffer(raw,dtype='<f4');assert np.isfinite(values).all()
            main.pop('external',None)
            if op['type']=='LayerNorm':
                assert main['useRMSNorm'] is True and abs(main['epsilon']-1e-6)<1e-10
                main['gamma']=values.tolist();main['beta']=[0.0]*count
            else:
                assert op['type']=='Const' and main['dataType']=='DT_FLOAT' and math.prod(main['dims'])==count
                main['float32s']=values.tolist()
            records.append({**entry,'source_type':0})
        assert writer.tell()<2300000000
        if (index+1)%16==0:
            writer.flush();os.fsync(writer.fileno())
            print(json.dumps({'mapped':index+1,'weight_bytes':writer.tell()}),flush=True)
    writer.flush();os.fsync(writer.fileno())
assert len(records)==320 and tie and tie['quant_bit']==8 and tie['quant_block']==16
# JSON export rounds constants to6decimalplaces. Restore full precision rotary
# frequencies from the selected GGUF rope parameters, not stock rounded data.
rotary=ops['Const','/rotary/Constant_1_output_0']['main']
values=np.float32(1)/np.power(np.float32(metadata['qwen35.rope.freq_base']),np.arange(0,64,2,dtype=np.float32)/np.float32(64))
assert np.max(np.abs(values-np.asarray(rotary['float32s'])))<5.1e-7
rotary['float32s']=values.tolist()
for op in graph['oplists']:
    if op['type']=='Convolution':
        ext=op['main']['external'];assert ext[0]>=0 and ext[0]+sum(ext[1:])<=weight_path.stat().st_size
    elif 'external' in op.get('main',{}):raise ValueError('Unmapped external graph data')
json_path=output/'llm.selected.json'
with json_path.open('x') as f:json.dump(graph,f,separators=(',',':'),allow_nan=False)
assert json_path.stat().st_size<33554432
mnnconvert.convert(['','-f','JSON','--modelFile',str(json_path),'--MNNModel',str(output/'llm.mnn.partial')])
assert (output/'llm.mnn.partial').is_file() and (output/'llm.mnn.partial').stat().st_size<16777216
# Finalize only a complete scratch artifact; it is not selected by production.
weight_path.rename(output/'llm.mnn.weight');(output/'llm.mnn.partial').rename(output/'llm.mnn')
config={'hidden_size':2048,'model_type':'qwen3_5','attention_mask':'float','attention_type':'full','is_mrope':True,'is_visual':False,'is_audio':False,'tie_embeddings':tie}
(output/'llm_config.json').write_text(json.dumps(config,indent=2)+'\n')
receipt={'selected_source_sha256':h.hexdigest(),'source_coverage':320,'matrix_ops':187,'source_quantizations':[12,13,14],'tie_embeddings':tie,'rotary_base':metadata['qwen35.rope.freq_base'],'weight_bytes':(output/'llm.mnn.weight').stat().st_size,'graph_bytes':(output/'llm.mnn').stat().st_size,'elapsed_s':time.monotonic()-started,'model_loaded':False,'production_changed':False,'records':records}
for name in ['llm.mnn.weight','llm.mnn','llm_config.json']:
    digest=hashlib.sha256()
    with (output/name).open('rb') as f:
        for part in iter(lambda:f.read(1048576),b''):digest.update(part)
    receipt.setdefault('sha256',{})[name]=digest.hexdigest()
(output/'conversion.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:v for k,v in receipt.items() if k!='records'}),flush=True)
