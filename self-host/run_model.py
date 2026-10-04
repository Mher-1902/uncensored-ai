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
    template = ROOT / 'self-host' / CONFIG['template']['filename']
    if not template.is_file() or digest(template) != CONFIG['template']['sha256']:
        raise SystemExit('Official Qwen chat template integrity check failed.')
    runtime = Path(os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}'))
    if not runtime.is_dir() or runtime.stat().st_uid != os.getuid() or runtime.stat().st_mode & 0o077:
        raise SystemExit('A private user runtime directory is required for cache erasure.')
    if subprocess.check_output(['findmnt','-n','-o','FSTYPE','-T',str(runtime)],text=True).strip() != 'tmpfs':
        raise SystemExit('The user runtime directory must be RAM-backed (tmpfs).')
    slot_dir = runtime / 'offscript-model'
    if slot_dir.is_symlink(): raise SystemExit('Refusing a symlink for the private slot directory.')
    slot_dir.mkdir(mode=0o700,exist_ok=True)
    if slot_dir.stat().st_uid != os.getuid() or slot_dir.stat().st_mode & 0o077:
        raise SystemExit('The slot directory must belong to this user with mode 0700.')
    # This revision gates erase behind slot-save-path. No save/restore action is used;
    # the private tmpfs path makes any accidental local slot file non-persistent.
    command = [str(binary),'-m',str(MODEL),'--alias','offscript','--host','127.0.0.1','--port','8081','--ctx-size',str(CONFIG['context']),'--parallel','1','--threads',str(CONFIG['threads']),'--threads-batch',str(CONFIG['threads']),'--batch-size','128','--ubatch-size','64','--n-gpu-layers','0','--flash-attn','off','--cache-type-k','f16','--cache-type-v','f16','--cache-ram','0','--no-cache-idle-slots','--no-context-shift','--jinja','--chat-template-file',str(template),'--slots','--slot-save-path',str(slot_dir),'--no-webui','--log-disable']
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
