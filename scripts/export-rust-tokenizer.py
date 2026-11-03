#!/usr/bin/env python3
"""Build-time only: preserve the selected GGUF's vocabulary and merge IDs.

Exports tokenizer metadata, never model weights or customer content. The Rust
runtime performs encoding; Python is not in that request path.
"""
import argparse, hashlib, json, struct
from pathlib import Path

QWEN35 = r"(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+|\p{N}| ?[^\s\p{L}\p{M}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+"

def export(model, config, destination):
    expected = json.loads(config.read_text())
    if model.stat().st_size != expected['bytes']:
        raise ValueError('Selected model size differs')
    digest = hashlib.sha256()
    with model.open('rb') as source:
        for block in iter(lambda: source.read(4*1024*1024), b''): digest.update(block)
    if digest.hexdigest() != expected['sha256']:
        raise ValueError('Selected model checksum differs')
    if destination.exists(): raise ValueError('Output directory must be new')
    fields = {}
    formats = {0:'B',1:'b',2:'H',3:'h',4:'I',5:'i',6:'f',7:'?',10:'Q',11:'q',12:'d'}
    with model.open('rb') as source:
        def read(n):
            if not 0<=n<=33554432: raise ValueError('Invalid metadata size')
            raw=source.read(n)
            if len(raw)!=n:raise ValueError('Incomplete metadata')
            return raw
        def scalar(fmt):return struct.unpack('<'+fmt,read(struct.calcsize('<'+fmt)))[0]
        def string():return read(scalar('Q')).decode('utf-8')
        def value(kind,keep):
            if kind in formats:return scalar(formats[kind])
            if kind==8:return string()
            if kind==9:
                item,count=scalar('I'),scalar('Q')
                if count>1_000_000 or item==9:raise ValueError('Invalid metadata array')
                values=[]
                for _ in range(count):
                    result=value(item,keep)
                    if keep:values.append(result)
                return values if keep else None
            raise ValueError('Unsupported metadata type')
        if read(4)!=b'GGUF' or scalar('I')!=3 or scalar('Q')!=320:raise ValueError('Wrong GGUF model')
        count=scalar('Q')
        if count>10000:raise ValueError('Too many metadata fields')
        for _ in range(count):
            key,kind=string(),scalar('I')
            keep=key.startswith('tokenizer.')
            result=value(kind,keep)
            if keep:fields[key]=result
            if source.tell()>33554432:raise ValueError('Tokenizer header exceeded bound')
    if fields['tokenizer.ggml.model']!='gpt2' or fields['tokenizer.ggml.pre']!='qwen35':raise ValueError('Unsupported tokenizer')
    vocab=fields['tokenizer.ggml.tokens'];merges=fields['tokenizer.ggml.merges'];types=fields['tokenizer.ggml.token_type']
    if len(vocab)!=248320 or len(merges)!=247587 or len(types)!=len(vocab) or len(set(vocab))!=len(vocab):raise ValueError('Vocabulary identity mismatch')
    added=[{'id':i,'content':token,'single_word':False,'lstrip':False,'rstrip':False,'normalized':False,'special':True} for i,token in enumerate(vocab) if types[i] in (3,4)]
    tokenizer={'version':'1.0','truncation':None,'padding':None,'added_tokens':added,'normalizer':None,
        'pre_tokenizer':{'type':'Sequence','pretokenizers':[{'type':'Split','pattern':{'Regex':QWEN35},'behavior':'Isolated','invert':False},{'type':'ByteLevel','add_prefix_space':False,'trim_offsets':False,'use_regex':False}]},
        'post_processor':None,'decoder':{'type':'ByteLevel','add_prefix_space':False,'trim_offsets':False,'use_regex':False},
        'model':{'type':'BPE','dropout':None,'unk_token':None,'continuing_subword_prefix':None,'end_of_word_suffix':None,'fuse_unk':False,'byte_fallback':False,'ignore_merges':False,'vocab':{token:i for i,token in enumerate(vocab)},'merges':[item.split(' ') for item in merges]}}
    if any(len(pair)!=2 for pair in tokenizer['model']['merges']):raise ValueError('Invalid merge pair')
    raw=(json.dumps(tokenizer,ensure_ascii=False,separators=(',',':'))+'\n').encode('utf-8')
    if len(raw)>33554432:raise ValueError('Tokenizer artifact exceeds bound')
    manifest={'schema':1,'model_sha256':expected['sha256'],'tokenizer_sha256':hashlib.sha256(raw).hexdigest(),'vocab_count':len(vocab),'merge_count':len(merges),'pre':'qwen35','add_bos':bool(fields.get('tokenizer.ggml.add_bos_token',False)),'bos_token_id':fields.get('tokenizer.ggml.bos_token_id')}
    # Public model metadata, readable by the unprivileged gateway container.
    # The containing deployment directory remains owner-controlled.
    destination.mkdir(mode=0o755,parents=True)
    (destination/'tokenizer.json').write_bytes(raw)
    (destination/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    (destination/'tokenizer.json').chmod(0o444)
    (destination/'manifest.json').chmod(0o444)
    return manifest

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--model',type=Path,required=True);parser.add_argument('--config',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();print(json.dumps(export(args.model,args.config,args.output)))
