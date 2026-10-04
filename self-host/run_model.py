#!/usr/bin/env python3
"""Refuse a cold start without real memory headroom; preserve native reasoning."""
import json, os, subprocess, threading, time
from pathlib import Path
from prepare import ROOT, CONFIG, MODEL, RUNTIME, readiness, digest
from readiness import temperatures

def main():
    readiness()
    binary = RUNTIME / 'build/bin/llama-server'
    if not binary.exists() or not MODEL.exists(): raise SystemExit('Run npm run fedora:prepare first.')
    if MODEL.stat().st_size!=CONFIG['bytes'] or digest(MODEL)!=CONFIG['sha256']: raise SystemExit('Model integrity check failed. Refusing to start.')
    command = [str(binary),'-m',str(MODEL),'--alias','offscript','--host','127.0.0.1','--port','8081','--ctx-size',str(CONFIG['context']),'--parallel','1','--threads',str(CONFIG['threads']),'--threads-batch',str(CONFIG['threads']),'--batch-size','128','--ubatch-size','64','--n-gpu-layers','0','--flash-attn','off','--cache-type-k','f16','--cache-type-v','f16','--cache-ram','0','--no-cache-idle-slots','--no-context-shift','--jinja','--slots','--no-webui','--log-disable']
    # Keep weights in RAM when possible; mmap is enabled by default. No mlock/swap tricks.
    env = dict(os.environ, OMP_NUM_THREADS=str(CONFIG['threads']))
    print('Starting one CPU inference slot on loopback. Prompt logging and cross-request caching are disabled.', flush=True)
    child = subprocess.Popen(command,env=env)
    def watch():
        while child.poll() is None:
            if any(t['celsius'] >= 85 for t in temperatures()):
                print('Thermal stop: laptop reached 85°C. Let it cool and inspect the fan before restarting.',flush=True)
                child.terminate();return
            time.sleep(2)
    threading.Thread(target=watch,daemon=True).start()
    try: code = child.wait()
    except KeyboardInterrupt:
        child.terminate()
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired: child.kill();child.wait()
        code = 130
    raise SystemExit(code)
if __name__ == '__main__': main()
