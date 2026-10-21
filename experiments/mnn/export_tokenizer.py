"""Private token-ID-forward fixture tokenizer from selectedGGUF. Encoding parity is not yet certified."""
from fixture_guard import require_fixture
require_fixture()
from pathlib import Path
import hashlib,json,struct
model=Path('/models/model.gguf');out=Path('/output');fields={}
assert all(not (out/name).exists() for name in ['tokenizer.txt','config.json','tokenizer-provenance.json'])
with model.open('rb') as f:
    def scalar(fmt):return struct.unpack('<'+fmt,f.read(struct.calcsize('<'+fmt)))[0]
    def string():
        n=scalar('Q');assert n<1048576;raw=f.read(n);assert len(raw)==n;return raw.decode()
    formats={0:'B',1:'b',2:'H',3:'h',4:'I',5:'i',6:'f',7:'?',10:'Q',11:'q',12:'d'}
    def skip(kind):
        if kind in formats:f.seek(struct.calcsize('<'+formats[kind]),1)
        elif kind==8:f.seek(scalar('Q'),1)
        elif kind==9:
            item=scalar('I');count=scalar('Q');assert count<=1000000 and item!=9
            if item in formats:f.seek(count*struct.calcsize('<'+formats[item]),1)
            else:
                for _ in range(count):skip(item)
        else:raise ValueError('metadata_type')
    assert f.read(4)==b'GGUF' and scalar('I')==3;assert scalar('Q')==320;nmeta=scalar('Q')
    for _ in range(nmeta):
        key=string();kind=scalar('I')
        if key in ['tokenizer.ggml.tokens','tokenizer.ggml.merges','tokenizer.ggml.token_type']:
            assert kind==9;item=scalar('I');count=scalar('Q');assert count<=1000000
            if item==8:fields[key]=[string() for _ in range(count)]
            else:assert item in [4,5];fields[key]=list(struct.unpack('<'+formats[item]*count,f.read(4*count)))
        elif key.startswith('tokenizer.') and key.endswith('_token_id'):
            assert kind==4;fields[key]=scalar('I')
        else:skip(kind)
        assert f.tell()<16777216
vocab=fields['tokenizer.ggml.tokens'];types=fields['tokenizer.ggml.token_type'];merges=fields['tokenizer.ggml.merges']
assert len(vocab)==len(types)==248320 and all('\n' not in x and '\r' not in x for x in vocab+merges)
special=[i for i,k in enumerate(types) if k in [3,4]]
stops=sorted({i for i,t in enumerate(vocab) if t in ['<|im_end|>','<|endoftext|>']})
assert fields['tokenizer.ggml.eos_token_id'] in stops
path=out/'tokenizer.txt';assert not path.exists()
with path.open('x') as f:
    f.write('430 3\n'+f'{len(special)} {len(stops)} 0\n')
    f.write(' '.join(map(str,special+stops))+'\n')
    f.write(f'{len(vocab)} {len(merges)}\n')
    for value in vocab+merges:f.write(value+'\n')
assert path.stat().st_size<33554432
config={'llm_model':'llm.mnn','llm_weight':'llm.mnn.weight','llm_config':'llm_config.json','tokenizer_file':'tokenizer.txt','backend_type':'cpu','thread_num':2,'precision':'normal','memory':'low','max_new_tokens':96,'sampler_type':'greedy','jinja':{'context':{'enable_thinking':False}}}
(out/'config.json').write_text(json.dumps(config,indent=2)+'\n')
result={'tokenizer_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'vocab_count':len(vocab),'merge_count':len(merges),'stop_ids':stops,'ids_preserved':True,'input_encoding_parity_tested':False,'production_changed':False}
(out/'tokenizer-provenance.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
