"""Reference-validated bounded GGUF quant-layout prototype; inference remains unvalidated.

No model runtime, graph import, network or Torch dependency. NumPy is imported
only when a codec is invoked. These routines preserve existing GGUF quantized
values, rather than quantizing from dense or stock weights.
"""
from __future__ import annotations
import struct

MAX_CHUNK = 8 * 1024 * 1024

def q4k_to_mnn(raw):
    """Return MNN high-nibble-first4bit bytes and FP32 [intercept,scale]."""
    import numpy as np
    source=np.frombuffer(raw,dtype=np.uint8).reshape(-1,144)
    blocks=source.shape[0]
    d=np.ascontiguousarray(source[:,:2]).view('<f2').astype('<f4').reshape(blocks,1)
    dmin=np.ascontiguousarray(source[:,2:4]).view('<f2').astype('<f4').reshape(blocks,1)
    scales=source[:,4:16]
    factor=np.empty((blocks,8),dtype=np.uint8)
    minimum=np.empty((blocks,8),dtype=np.uint8)
    factor[:,:4]=scales[:,:4]&63
    minimum[:,:4]=scales[:,4:8]&63
    for j in range(4,8):
        factor[:,j]=(scales[:,j+4]&15)|((scales[:,j-4]>>6)<<4)
        minimum[:,j]=(scales[:,j+4]>>4)|((scales[:,j]>>6)<<4)
    scale=factor.astype('<f4')*d
    gguf_bias=-minimum.astype('<f4')*dmin
    # Wire-map codes0..15 decode as signed-8..7; compensate intercept.
    alpha=np.empty((blocks,8,2),dtype='<f4')
    alpha[:,:,0]=gguf_bias+np.float32(8)*scale
    alpha[:,:,1]=scale
    packed=source[:,16:].reshape(blocks,4,32)
    codes=np.stack((packed&15,packed>>4),axis=2).reshape(blocks,8,32)
    pairs=codes.reshape(blocks,8,16,2)
    encoded=((pairs[:,:,:,0]<<4)|pairs[:,:,:,1]).astype(np.uint8)
    return encoded.tobytes(),alpha.tobytes()

def q6k_to_exact_mnn8(raw):
    """Expand Q6_K codes to signed8 representation without requantization."""
    import numpy as np
    source=np.frombuffer(raw,dtype=np.uint8).reshape(-1,210)
    blocks=source.shape[0]
    ql=source[:,:128].reshape(blocks,2,64)
    qh=source[:,128:192].reshape(blocks,2,32)
    out=np.empty((blocks,2,4,32),dtype=np.uint8)
    out[:,:,0,:]=(ql[:,:,:32]&15)|((qh&3)<<4)
    out[:,:,1,:]=(ql[:,:,32:]&15)|(((qh>>2)&3)<<4)
    out[:,:,2,:]=(ql[:,:,:32]>>4)|(((qh>>4)&3)<<4)
    out[:,:,3,:]=(ql[:,:,32:]>>4)|(((qh>>6)&3)<<4)
    # (q+96)-128 == q-32, original Q6_K value before its scale.
    out += np.uint8(96)
    factor=np.ascontiguousarray(source[:,192:208]).view(np.int8).astype('<f4')
    d=np.ascontiguousarray(source[:,208:210]).view('<f2').astype('<f4').reshape(blocks,1)
    alpha=factor*d
    return out.tobytes(),alpha.tobytes()


def q5k_to_exact_mnn8(raw):
    """Q5_K→signed8 wire mapping, sampled against the pinned GGUF reference."""
    import numpy as np
    source=np.frombuffer(raw,dtype=np.uint8).reshape(-1,176)
    blocks=source.shape[0]
    d=np.ascontiguousarray(source[:,:2]).view('<f2').astype('<f4').reshape(blocks,1)
    dmin=np.ascontiguousarray(source[:,2:4]).view('<f2').astype('<f4').reshape(blocks,1)
    scales=source[:,4:16]
    factors=np.empty((blocks,8),dtype=np.uint8);minimum=np.empty((blocks,8),dtype=np.uint8)
    factors[:,:4]=scales[:,:4]&63;minimum[:,:4]=scales[:,4:8]&63
    for j in range(4,8):
        factors[:,j]=(scales[:,j+4]&15)|((scales[:,j-4]>>6)<<4)
        minimum[:,j]=(scales[:,j+4]>>4)|((scales[:,j]>>6)<<4)
    high=source[:,16:48];low=source[:,48:].reshape(blocks,4,32)
    codes=np.empty((blocks,8,32),dtype=np.uint8)
    for pair in range(4):
        codes[:,pair*2]=(low[:,pair]&15)+(((high>>(pair*2))&1)<<4)
        codes[:,pair*2+1]=(low[:,pair]>>4)+(((high>>(pair*2+1))&1)<<4)
    scale=factors.astype('<f4')*d
    alpha=np.empty((blocks,8,2),dtype='<f4')
    alpha[:,:,0]=-minimum.astype('<f4')*dmin+np.float32(16)*scale
    alpha[:,:,1]=scale
    # q+112 uses signed8 q-16; the alpha intercept compensates that shift.
    return (codes+np.uint8(112)).tobytes(),alpha.tobytes()

def mnn_header(ic,oc,bits):
    if bits not in (4,8):raise ValueError('Only reviewed4/8bit mappings')
    int32=ic>65535 or oc>65535
    shape=struct.pack('<ii' if int32 else '<HH',oc,ic)
    offset=1<<(bits-1)
    table=bytes((x%256 for x in range(-offset,offset)))
    return b'\x02'+shape+bytes([0 if bits==8 else len(table)])+table,int32

def write_matrix(reader,writer,*,source_offset,ic,oc,gguf_type,rows_per_chunk=8):
    """Write one self-contained Conv external blob using two bounded passes.

    reader is seekable read-only GGUF; writer is a scratch-output binary file.
    ic/oc are validated graph dimensions. Returned offsets include zero bias.
    Only handlesQ4_K(type12),Q5_K(type13) andQ6_K(type14) from selected tensor inventory.
    Full graph correctness/source provenance are caller responsibilities.
    """
    if not (isinstance(ic,int) and isinstance(oc,int) and 0<ic<=65536 and 0<oc<=300000):
        raise ValueError('Unreviewed matrix geometry')
    if ic%256:raise ValueError('GGUF K-quant rows require256alignment')
    if not isinstance(rows_per_chunk,int) or not 1<=rows_per_chunk<=64:
        raise ValueError('Invalid chunk size')
    if gguf_type==12:
        source_block=144;bits=4;alpha_per_block=8*2*4;codec=q4k_to_mnn
        asym=True;group=32
    elif gguf_type==13:
        source_block=176;bits=8;alpha_per_block=8*2*4;codec=q5k_to_exact_mnn8
        asym=True;group=32
    elif gguf_type==14:
        source_block=210;bits=8;alpha_per_block=16*4;codec=q6k_to_exact_mnn8
        asym=False;group=16
    else:raise ValueError('Unsupported source quantization; never guess')
    row_bytes=ic//256*source_block
    if row_bytes*rows_per_chunk>MAX_CHUNK:raise ValueError('Chunk memory guard')
    start=writer.tell()
    header,int32=mnn_header(ic,oc,bits)
    writer.write(header)
    for alpha_pass in (False,True):
        for first in range(0,oc,rows_per_chunk):
            rows=min(rows_per_chunk,oc-first)
            reader.seek(source_offset+first*row_bytes)
            raw=reader.read(rows*row_bytes)
            if len(raw)!=rows*row_bytes:raise ValueError('Truncated GGUF row chunk')
            codes,alpha=codec(raw)
            writer.write(alpha if alpha_pass else codes)
    weight_len=len(header)+ic*oc*bits//8
    alpha_len=ic*oc//256*alpha_per_block
    if writer.tell()!=start+weight_len+alpha_len:
        raise ValueError('Quant layout size invariant failed')
    # There are no learned matrix biases in this selected GGUF inventory.
    writer.write(b'\x00'*(oc*4))
    return {
        'quanParameter':{'quantScale':1.0,'scaleIn':0.0,'scaleOut':0.0,
            'useInt32':False,'has_scaleInt':False,'shapeInt32':int32,
            'type':1,'aMaxOrBits':bits,'aMin':1 if asym else 0,
            'readType':1 if asym else 0,'weightSize':0,'scaleStorage':'FP32'},
        'external':[start,weight_len,alpha_len,oc*4,0],
        'tie_embeddings':{'weight_offset':start+len(header),
            'alpha_offset':start+weight_len,'alpha_size':alpha_len,
            'quant_bit':bits,'quant_block':group,'alpha_dtype':'fp32'},
    }
