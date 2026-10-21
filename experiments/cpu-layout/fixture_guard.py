"""Start-time guard; a separate parent watchdog remains mandatory."""
from pathlib import Path
import os,sys
def require_fixture():
 assert sys.platform=='linux' and os.environ.get('OFFSCRIPT_TEST_FIXTURE')=='private-cpu-model-test'
 root=Path('/sys/fs/cgroup')
 assert 0<int((root/'memory.max').read_text())<=1024**3
 assert (root/'memory.swap.max').read_text().strip()=='0'
 quota,period=map(int,(root/'cpu.max').read_text().split())
 assert quota>0 and period>0 and quota/period<=.25
 assert sorted(p.name for p in Path('/sys/class/net').iterdir())==['lo']
 assert os.statvfs('/').f_flag & os.ST_RDONLY
 sensors=[int(p.read_text())/1000 for p in Path('/sys/class/thermal').glob('thermal_zone*/temp')]
 assert sensors and all(-20<=v<=110 for v in sensors) and max(sensors)<75
