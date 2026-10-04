#!/usr/bin/env python3
"""Read-only Fedora readiness report. No packages, settings or services changed."""
import json, platform
from pathlib import Path

def memory():
    values = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        values[key] = int(value.strip().split()[0]) // 1024
    return values

def temperatures():
    result = []
    for hw in Path('/sys/class/hwmon').glob('hwmon*'):
        try: name = (hw / 'name').read_text().strip()
        except OSError: continue
        for sensor in hw.glob('temp*_input'):
            try: result.append({'sensor': name, 'celsius': int(sensor.read_text()) / 1000})
            except (OSError, ValueError): pass
    return result

def report():
    if platform.system() != 'Linux': return {'platform': platform.system(), 'ready': False, 'reason': 'Run this on the Fedora laptop.'}
    mem = memory()
    cpu = Path('/proc/cpuinfo').read_text()
    model = next((l.split(':',1)[1].strip() for l in cpu.splitlines() if l.startswith('model name')), 'unknown')
    flags = next((l.split(':',1)[1].split() for l in cpu.splitlines() if l.startswith('flags')), [])
    config = json.loads((Path(__file__).parent / 'model.json').read_text())
    ready = mem['MemTotal'] >= config['minimumTotalMiB'] and mem['MemAvailable'] >= config['minimumAvailableMiB']
    return {'platform': platform.system(), 'architecture': platform.machine(), 'cpu': model, 'avx': 'avx' in flags, 'avx2': 'avx2' in flags, 'totalMiB': mem['MemTotal'], 'availableMiB': mem['MemAvailable'], 'swapUsedMiB': mem['SwapTotal']-mem['SwapFree'], 'temperatures': temperatures(), 'ready': ready, 'model': config['name'], 'note': 'Readiness is an initial memory check, not a latency or thermal guarantee.'}
if __name__ == '__main__': print(json.dumps(report(), indent=2))
