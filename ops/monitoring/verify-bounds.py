#!/usr/bin/env python3
"""Verify actual monitor scope limits, not just Docker's requested settings."""
from pathlib import Path
import json
from collect import docker,cgroup_scope

LIMITS={
    'offscript-monitor-grafana':(268435456,'15000 100000',96),
    'offscript-monitor-prometheus':(201326592,'10000 100000',96),
    'offscript-monitor-exporter':(50331648,'3000 100000',96),
    'offscript-monitor-proxy':(50331648,'3000 100000',32),
}
for name,(memory,cpu,pids) in LIMITS.items():
    item=json.loads(docker(['inspect','--format','{"id":"{{.Id}}","pid":{{.State.Pid}},"running":{{.State.Running}}}',name]))
    assert item['running'] is True,'A monitor is not running'
    scope=cgroup_scope(Path('/proc/'+str(item['pid'])+'/cgroup').read_text(),item['id'])
    expected={'memory.max':str(memory),'memory.swap.max':'0','cpu.max':cpu,'pids.max':str(pids)}
    for key,value in expected.items():
        actual=(scope/key).read_text().strip()
        assert actual==value,f'{name}: {key} expected {value}, found {actual}'
