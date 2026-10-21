"""Bounded GGUF descriptor reader for Samsung experiments; never materializes weights/tokenizer."""
import struct

def layout(path):
    with open(path,'rb') as f:
        def scalar(fmt):
            n=struct.calcsize('<'+fmt);data=f.read(n);assert len(data)==n
            return struct.unpack('<'+fmt,data)[0]
        def string():
            n=scalar('Q');assert n<1048576;raw=f.read(n);assert len(raw)==n
            return raw.decode()
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
        assert f.read(4)==b'GGUF' and scalar('I')==3
        count=scalar('Q');nmeta=scalar('Q');assert count==320 and nmeta<1000
        metadata={}
        for _ in range(nmeta):
            key=string();kind=scalar('I')
            if kind in formats and not key.startswith('tokenizer.'):
                metadata[key]=scalar(formats[kind])
            elif kind==8 and key=='general.architecture':metadata[key]=string()
            else:skip(kind)
            assert f.tell()<16777216
        tensors=[]
        for _ in range(count):
            name=string();nd=scalar('I');assert nd<5
            shape=[scalar('Q') for _ in range(nd)];kind=scalar('I');offset=scalar('Q')
            tensors.append({'name':name,'shape':shape,'type':kind,'offset':offset})
        alignment=metadata.get('general.alignment',32);assert alignment in [32,64,128,256]
        start=((f.tell()+alignment-1)//alignment)*alignment
        return tensors,start,metadata
