#!/usr/bin/env python3
"""Install pinned official Linux runtimes in the project, without root."""
import hashlib, json, platform, shutil, subprocess, tarfile, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / 'self-host/runtimes.json').read_text())
RUNTIME = ROOT / '.runtime'

def install(name, url, prefix, checksum, version_command):
    target = RUNTIME / name
    if target.exists():
        current = subprocess.check_output([str(target / version_command), '--version' if name == 'node' else 'version'], text=True).splitlines()[0]
        if CONFIG[name]['version'] not in current: raise SystemExit(f'Existing {name} version differs. It was preserved; inspect it before upgrading.')
        print(f'{name} {current} already installed.'); return
    archive = RUNTIME / (prefix + '.download')
    with urllib.request.urlopen(url, timeout=60) as source, archive.open('wb') as output:
        shutil.copyfileobj(source, output, 1024*1024)
    with archive.open('rb') as source: digest = hashlib.file_digest(source, 'sha256').hexdigest()
    if digest != checksum: raise SystemExit(f'{name} checksum failed; refusing to extract or run it.')
    with tarfile.open(archive) as source: source.extractall(RUNTIME, filter='data')
    (RUNTIME / prefix).rename(target)
    archive.unlink()
    print(f'Installed verified {name} {CONFIG[name]["version"]}.')

def main():
    if platform.system() != 'Linux' or platform.machine() != 'x86_64': raise SystemExit('Use this bootstrap on Fedora x86_64.')
    RUNTIME.mkdir(exist_ok=True)
    node = CONFIG['node']; node_prefix = f'node-v{node["version"]}-linux-x64'
    install('node', f'https://nodejs.org/dist/v{node["version"]}/{node_prefix}.tar.xz', node_prefix, node['sha256'], 'bin/node')
    tunnel = CONFIG['tailscale']; tunnel_prefix = f'tailscale_{tunnel["version"]}_amd64'
    install('tailscale', f'https://dl.tailscale.com/stable/{tunnel_prefix}.tgz', tunnel_prefix, tunnel['sha256'], 'tailscale')
    print('For project commands: export PATH="$PWD/.runtime/node/bin:$PATH"')

if __name__ == '__main__': main()
