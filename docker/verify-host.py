"""Fail closed before starting the unattended Samsung container profile."""
import json, pathlib, platform, subprocess, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'self-host'))
from readiness import report

if platform.system() != 'Linux' or platform.machine() != 'x86_64':
    raise SystemExit('The CPU model profile requires the Linux x86_64 server.')
host = report()
if not host['ready'] or not host['temperatures']:
    raise SystemExit('Available RAM and working thermal sensors are required.')
if max(t['celsius'] for t in host['temperatures']) >= 70:
    raise SystemExit('Let the CPU cool below 70C before starting.')
if pathlib.Path('/sys/class/power_supply/ADP1/online').read_text().strip() != '1':
    raise SystemExit('Connect Samsung AC power before starting.')
flags = pathlib.Path('/proc/cpuinfo').read_text().split('flags', 1)[1].splitlines()[0].split(':', 1)[1].split()
if not {'avx', 'f16c'}.issubset(flags):
    raise SystemExit('This image requires AVX and F16C CPU support.')
security = json.loads(subprocess.check_output(['docker', 'info', '--format', '{{json .SecurityOptions}}'], text=True))
if 'name=rootless' not in security:
    raise SystemExit('Use the rootless Docker daemon for this profile.')
control = subprocess.check_output(['docker', 'info', '--format', '{{.CgroupVersion}} {{.CgroupDriver}}'], text=True).strip()
if control != '2 systemd':
    raise SystemExit('Cgroup v2 with systemd is required to enforce resource limits.')
swap = subprocess.check_output(['systemctl', '--user', 'show', 'offscript-containers.slice', '-p', 'MemorySwapMax', '--value'], text=True).strip()
if swap != '0' or subprocess.run(['systemctl', '--user', 'is-active', '--quiet', 'offscript-containers.slice']).returncode != 0:
    raise SystemExit('Install and start offscript-containers.slice with MemorySwapMax=0 first.')
for service in ['offscript-model', 'offscript-web']:
    if subprocess.run(['systemctl', '--user', 'is-active', '--quiet', service]).returncode == 0:
        raise SystemExit('Stop the native model/gateway before starting their containers.')
