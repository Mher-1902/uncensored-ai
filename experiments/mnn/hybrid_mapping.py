"""Fail-closed graph-mapping prototype. Run/verify on Samsung only.

Reads JSON inventories, does not load model runtime, write converted weights,
fetch anything, or modify source/graph. Naming/topology assertions are deliberate:
a cached stock graph is untrusted until all320 selected tensors are accounted for.
"""
from __future__ import annotations
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
import re

FULL = frozenset(range(3,24,4))
BLOCK = re.compile(r'(?:^|/)(?:blocks|layers)\.(\d+)(?:/|$)')

class IncompatibleGraph(ValueError):
    pass

def require(ok, reason):
    if not ok:
        raise IncompatibleGraph(reason)

def block_id(op):
    match=BLOCK.search(op.get('name',''))
    return int(match.group(1)) if match else None

def has_module(op, suffix):
    # Module component boundaries matter: norm must not match q_norm.
    path=op.get('name','').replace('.', '/')
    return '/'+suffix.replace('.','/')+'/' in path+'/'

def count_elements(op):
    dims=op.get('main',{}).get('dims')
    if dims is None:
        payload=[v for k,v in op.get('main',{}).items() if k in {'float32s','int32s','int64s','uint8s','int8s'}]
        require(len(payload)==1 and isinstance(payload[0],list) and len(payload[0])==1,'Unreviewed scalar Const')
        return 1
    require(isinstance(dims,list) and all(isinstance(x,int) and x>0 for x in dims),
            'Const shape unavailable: '+op.get('name',''))
    return math.prod(dims)

def compile_manifest(graph, inventory):
    ops=graph['oplists']
    tensors={t['name']:t for t in inventory['tensors']}
    require(len(tensors)==len(inventory['tensors'])==320,'Expected320unique GGUF tensors')
    counts=collections.Counter(op['type'] for op in ops)
    require(all(counts[k]==v for k,v in {'Convolution':187,'LayerNorm':79,
        'LinearAttention':18,'Attention':6,'Const':74}.items()),'Unexpected graph structure')
    producer={}
    for op in ops:
        for index in op.get('outputIndexes',[]):
            require(index not in producer,'Multiple tensor producers')
            producer[index]=op
    by_type=collections.defaultdict(list)
    for op in ops:
        by_type[op['type']].append(op)
    entries=[]
    used_ops=set()
    used_tensors=set()

    def unique(kind,bid,module):
        candidates=[op for op in by_type[kind] if block_id(op)==bid and has_module(op,module)]
        require(len(candidates)==1,f'Ambiguous/missing {kind} block{bid} module{module}: '
                +str([o.get('name') for o in candidates]))
        return candidates[0]

    def record(op, source, recipe, shape=None):
        require(source in tensors,'Missing selected tensor: '+source)
        key=(op['type'],op['name'])
        require(key not in used_ops,'Graph op mapped twice: '+op['name'])
        used_ops.add(key);used_tensors.add(source)
        tensor=tensors[source]
        if shape is not None:
            require(tensor['shape']==list(shape),'GGUF shape mismatch: '+source)
        entries.append({'op_type':op['type'],'op_name':op['name'],'source':source,
                        'source_shape':tensor['shape'],'recipe':recipe})

    def matrix(bid,module,suffix,oc,ic):
        op=unique('Convolution',bid,module)
        common=op['main']['common']
        require(common['inputCount']==ic and common['outputCount']==oc,
                'Convolution geometry mismatch: '+op['name'])
        require(common['kernelX']==common['kernelY']==common['group']==1,
                'Unexpected non-matrix convolution')
        record(op,f'blk.{bid}.{suffix}.weight','stream_existing_quantization',(ic,oc))

    def norm(bid,module,suffix,length):
        op=unique('LayerNorm',bid,module)
        record(op,f'blk.{bid}.{suffix}.weight','effective_gamma_direct_zero_beta',(length,))

    def ancestors(index):
        seen=set();result=[];stack=[index]
        while stack:
            current=stack.pop()
            if current in seen:continue
            seen.add(current)
            require(len(seen)<500,'Unexpected gate ancestry size')
            op=producer.get(current)
            require(op is not None,'Missing gate producer')
            if op['type']=='Const':result.append(op);continue
            # Do not walk all the way into learned projections and earlier blocks.
            if op['type'] in {'Convolution','Input','LayerNorm','LinearAttention','Attention'}:
                continue
            stack.extend(op.get('inputIndexes',[]))
        return result

    for bid in range(24):
        for module,suffix,oc,ic in [
            ('mlp.gate_proj','ffn_gate',6144,2048),
            ('mlp.up_proj','ffn_up',6144,2048),
            ('mlp.down_proj','ffn_down',2048,6144)]:
            matrix(bid,module,suffix,oc,ic)
        norm(bid,'input_layernorm','attn_norm',2048)
        norm(bid,'post_attention_layernorm','post_attention_norm',2048)
        if bid in FULL:
            for module,suffix,oc in [('q_proj','attn_q',4096),('k_proj','attn_k',512),
                                     ('v_proj','attn_v',512),('o_proj','attn_output',2048)]:
                matrix(bid,'self_attn.'+module,suffix,oc,2048)
            norm(bid,'self_attn.q_norm','attn_q_norm',256)
            norm(bid,'self_attn.k_norm','attn_k_norm',256)
        else:
            for module,suffix,oc,ic in [('in_proj_qkv','attn_qkv',6144,2048),
                ('in_proj_z','attn_gate',2048,2048),('in_proj_b','ssm_beta',16,2048),
                ('in_proj_a','ssm_alpha',16,2048),('out_proj','ssm_out',2048,2048)]:
                matrix(bid,'self_attn.'+module,suffix,oc,ic)
            norm(bid,'self_attn.norm','ssm_norm',128)
            linear=[op for op in by_type['LinearAttention'] if block_id(op)==bid]
            require(len(linear)==1,'Missing recurrent op')
            linear=linear[0]
            require(len(linear['inputIndexes'])==4,'Unexpected recurrent input contract')
            main=linear['main']
            require(all(main[k]==v for k,v in {'attn_type':'gated_delta_rule',
                'num_k_heads':16,'num_v_heads':16,'head_k_dim':128,'head_v_dim':128,
                'use_qk_l2norm':True}.items()),'Recurrent geometry mismatch')
            conv=producer[linear['inputIndexes'][3]]
            require(conv['type']=='Const' and conv['main']['dims']==[6144,1,4],
                    'Conv1D must have a unique raw-Const producer')
            record(conv,f'blk.{bid}.ssm_conv1d.weight','f32_flat_reinterpret_6144_1_4',(4,6144))
            gate_constants=[op for op in ancestors(linear['inputIndexes'][1])
                            if count_elements(op)==16]
            negative=[op for op in gate_constants if op.get('name')==
                      f'/blocks.{bid}/self_attn/Neg_output_0']
            require(len(gate_constants)==2 and len(negative)==1,
                    'Gate constants require reviewed exact topology/names')
            neg=negative[0];dt=next(op for op in gate_constants if op is not neg)
            require(dt['name'].startswith('onnx::Add_'),'Unexpected dt-bias producer')
            record(neg,f'blk.{bid}.ssm_a','already_negative_exp_A_direct',(16,))
            record(dt,f'blk.{bid}.ssm_dt.bias','dt_bias_direct',(16,))

    final=[op for op in by_type['LayerNorm'] if block_id(op) is None]
    require(len(final)==1,'Unexpected final norm inventory')
    record(final[0],'output_norm.weight','effective_gamma_direct_zero_beta',(2048,))
    lm=[op for op in by_type['Convolution'] if block_id(op) is None]
    require(len(lm)==1,'Unexpected final output inventory')
    require(lm[0]['main']['common']['inputCount']==2048 and
            lm[0]['main']['common']['outputCount']==248320,'LM geometry mismatch')
    record(lm[0],'token_embd.weight','tied_output_embedding_exact_quantized_values',(2048,248320))
    require(used_tensors==set(tensors),'Unmapped GGUF learned tensors: '+str(sorted(set(tensors)-used_tensors)))
    require(len(entries)==320,'Coverage count mismatch')
    remaining=[op for op in by_type['Const'] if (op['type'],op['name']) not in used_ops]
    require(len(remaining)==20,'Expected20explicit structural constants to review')
    # This is an inspection manifest, deliberately NOT a conversion-ready approval.
    return {'mapping_entries':entries,'source_coverage':len(used_tensors),
            'remaining_structural_constants':remaining,'converted':False,
            'ready_to_convert':False,'required_gate':'Review20structural constants, tokenizer and quantization fixtures'}

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('graph',type=Path)
    p.add_argument('inventory',type=Path)
    p.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    require(a.graph.stat().st_size<16*1024*1024 and a.inventory.stat().st_size<1024*1024,
            'Oversized input metadata')
    result=compile_manifest(json.loads(a.graph.read_text()),json.loads(a.inventory.read_text()))
    a.output.write_text(json.dumps(result,indent=2)+'\n')
