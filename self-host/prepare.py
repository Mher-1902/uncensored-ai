#!/usr/bin/env python3
"""Build pinned CPU-only llama.cpp and fetch checksum-verified weights on Fedora."""
import hashlib, json, platform, shutil, subprocess, urllib.request
from pathlib import Path
from readiness import memory, temperatures
ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / 'self-host/model.json').read_text())
RUNTIME = ROOT / '.runtime/llama.cpp'
MODEL = ROOT / '.data/models' / CONFIG['filename']

def readiness():
    if platform.system() != 'Linux' or platform.machine() != 'x86_64': raise SystemExit('Run the Fedora x86_64 setup on the Samsung laptop.')
    mem = memory()
    if mem['MemTotal'] < CONFIG['minimumTotalMiB'] or mem['MemAvailable'] < CONFIG['minimumAvailableMiB']:
        raise SystemExit('Not enough available RAM for this model profile. Close other apps and rerun fedora:inspect. Swap is not counted as RAM.')
    if any(t['celsius'] >= 80 for t in temperatures()): raise SystemExit('The laptop is already hot. Let it cool before building or loading a model.')

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(4*1024*1024), b''): h.update(chunk)
    return h.hexdigest()

def prepare():
    readiness()
    for tool in ['git','cmake','g++','make','node']:
        if not shutil.which(tool): raise SystemExit(f'Missing {tool}. Install Fedora prerequisites described in docs/FEDORA.md.')
    major = int(subprocess.check_output(['node','--version'], text=True).lstrip('v').split('.')[0])
    if major < 24: raise SystemExit('Node.js 24 or later is required.')
    if not RUNTIME.exists():
        RUNTIME.mkdir(parents=True)
        subprocess.run(['git','init',str(RUNTIME)],check=True)
        subprocess.run(['git','-C',str(RUNTIME),'remote','add','origin','https://github.com/ggml-org/llama.cpp.git'],check=True)
    subprocess.run(['git','-C',str(RUNTIME),'fetch','--depth=1','origin',CONFIG['llamaRevision']],check=True)
    subprocess.run(['git','-C',str(RUNTIME),'checkout','--detach',CONFIG['llamaRevision']],check=True)
    flags = Path('/proc/cpuinfo').read_text().split('flags',1)[1].splitlines()[0].split(':',1)[1].split()
    cmake = ['cmake','-S',str(RUNTIME),'-B',str(RUNTIME/'build'),'-DCMAKE_BUILD_TYPE=Release','-DGGML_NATIVE=OFF','-DGGML_CPU_ALL_VARIANTS=OFF','-DGGML_BLAS=OFF','-DGGML_CUDA=OFF','-DGGML_VULKAN=OFF','-DLLAMA_BUILD_TESTS=OFF','-DLLAMA_BUILD_EXAMPLES=OFF']
    for feature in ['AVX','AVX2','FMA','F16C']: cmake.append(f'-DGGML_{feature}={"ON" if feature.lower() in flags else "OFF"}')
    for feature in ['AVX512','AVX512_VBMI','AVX512_VNNI','AVX512_BF16','AVX_VNNI']: cmake.append(f'-DGGML_{feature}=OFF')
    subprocess.run(cmake,check=True)
    # One build worker avoids a large compile-memory/heat spike on the old laptop.
    subprocess.run(['cmake','--build',str(RUNTIME/'build'),'--target','llama-server','--parallel','1'],check=True)
    MODEL.parent.mkdir(parents=True,exist_ok=True)
    if MODEL.exists() and MODEL.stat().st_size==CONFIG['bytes'] and digest(MODEL)==CONFIG['sha256']:
        print('Verified model already present.');return
    if shutil.disk_usage(MODEL.parent).free < 3*1024**3: raise SystemExit('Keep at least 3 GiB free for the verified download.')
    partial = MODEL.with_suffix('.gguf.partial')
    url = f'https://huggingface.co/{CONFIG["repository"]}/resolve/{CONFIG["revision"]}/{CONFIG["filename"]}?download=true'
    print('Downloading the pinned 1.11 GB model. No chat data is downloaded or saved.')
    try:
        with urllib.request.urlopen(url, timeout=60) as source, partial.open('wb') as target:
            shutil.copyfileobj(source,target,length=4*1024*1024)
        if partial.stat().st_size!=CONFIG['bytes'] or digest(partial)!=CONFIG['sha256']: raise SystemExit('Model checksum failed. The unverified file will not run.')
        partial.replace(MODEL)
    finally:
        if partial.exists(): partial.unlink()
    print('Fedora model files prepared. Run fedora:model, then the gateway; benchmark before publishing inference.')
if __name__ == '__main__': prepare()
