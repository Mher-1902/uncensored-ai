#!/usr/bin/env python3
"""Write content-free Samsung metrics. No Docker socket is given to a container."""
from pathlib import Path
import argparse,json,math,os,re,shutil,subprocess,time,urllib.request

PRODUCTION=('offscript-model-1','offscript-gateway-1','offscript-ingress-1')
MONITORS=('offscript-monitor-grafana','offscript-monitor-prometheus','offscript-monitor-exporter','offscript-monitor-proxy')
PRIVATE_PREFIXES=('offscript-check-','offscript-rust-','offscript-native-','offscript-canonical-','buildx_buildkit_offscript-')
NAME=re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,126}\Z')
ID=re.compile(r'[0-9a-f]{64}\Z')

def allowed(name):
    return bool(NAME.fullmatch(name)) and (name in PRODUCTION+MONITORS or name.startswith(PRIVATE_PREFIXES))

def metric(lines,metric_name,value,**labels):
    number=float(value)
    if not math.isfinite(number):raise ValueError('Non-finite metric')
    suffix='{'+','.join(k+'='+json.dumps(str(v)) for k,v in sorted(labels.items()))+'}' if labels else ''
    lines.append(metric_name+suffix+' '+str(value))

def cgroup_scope(raw,container_id):
    """Use the actual Docker scope ancestor, where inherited limits live."""
    if not ID.fullmatch(container_id):raise ValueError('Invalid container ID')
    unified=[line[3:] for line in raw.splitlines() if line.startswith('0::')]
    if len(unified)!=1:raise ValueError('Missing unified cgroup')
    parts=Path(unified[0]).parts
    if '..' in parts:raise ValueError('Invalid cgroup path')
    expected='docker-'+container_id+'.scope'
    if expected not in parts:raise ValueError('Not the container scope')
    return Path('/sys/fs/cgroup').joinpath(*parts[1:parts.index(expected)+1])

def docker(args):
    uid=os.geteuid()
    env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','DOCKER_CONFIG':'/nonexistent',
         'DOCKER_HOST':f'unix:///run/user/{uid}/docker.sock'}
    return subprocess.check_output(['/usr/bin/docker',*args],env=env,timeout=4,text=True).strip()

def collect():
    lines=[]
    cpu=Path('/proc/stat').read_text().splitlines()[0].split()
    ticks=os.sysconf('SC_CLK_TCK')
    for mode,value in zip(('user','nice','system','idle','iowait','irq','softirq','steal'),cpu[1:]):metric(lines,'offscript_host_cpu_seconds_total',int(value)/ticks,mode=mode)
    memory={k:int(v.split()[0])*1024 for k,v in (line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines())}
    for kind in ('MemTotal','MemAvailable'):metric(lines,'offscript_host_memory_bytes',memory[kind],kind=kind)
    metric(lines,'offscript_host_load1',os.getloadavg()[0])
    metric(lines,'offscript_host_uptime_seconds',float(Path('/proc/uptime').read_text().split()[0]))
    temperatures=[int(p.read_text())/1000 for p in Path('/sys/class/thermal').glob('thermal_zone*/temp')]
    if temperatures:metric(lines,'offscript_host_temperature_celsius',max(temperatures))
    disk=shutil.disk_usage('/home/rog/dev')
    metric(lines,'offscript_host_disk_bytes',disk.total,kind='total');metric(lines,'offscript_host_disk_bytes',disk.free,kind='free')
    power=Path('/sys/class/power_supply/ADP1/online')
    if power.exists():metric(lines,'offscript_host_ac_connected',int(power.read_text()))
    try:
        with urllib.request.urlopen('http://127.0.0.1:8080/api/health',timeout=2) as response:health=json.loads(response.read(8192))
        metric(lines,'offscript_gateway_health_up',1)
        for source,target in (('ready','ready'),('busy','busy'),('queued','queued')):
            value=health[source]
            if not isinstance(value,(int,bool)) or not 0<=value<=10000:raise ValueError('Invalid health field')
            metric(lines,'offscript_gateway_'+target,int(value))
    except (OSError,ValueError,KeyError):metric(lines,'offscript_gateway_health_up',0)
    try:
        candidates={}
        for line in docker(['ps','-a','--no-trunc','--format','{{.ID}} {{.Names}}']).splitlines():
            ident,_,name=line.partition(' ')
            if allowed(name) and ID.fullmatch(ident):candidates[name]=ident
        if len(candidates)>40:raise ValueError('Too many selected containers')
        for name in PRODUCTION+MONITORS:metric(lines,'offscript_container_present',int(name in candidates),name=name)
        if candidates:
            # An explicit template avoids collecting Config.Env, commands or logs.
            template='{"id":"{{.Id}}","name":"{{.Name}}","pid":{{.State.Pid}},"running":{{.State.Running}},"restarts":{{.RestartCount}}}'
            rows=docker(['inspect','--format',template,*candidates.values()]).splitlines()
            for row in rows:
                item=json.loads(row);name=item['name'].lstrip('/');ident=item['id']
                if candidates.get(name)!=ident:raise ValueError('Unexpected container identity')
                metric(lines,'offscript_container_running',int(item['running']),name=name)
                metric(lines,'offscript_container_restarts_total',item['restarts'],name=name)
                if not item['running']:continue
                try:
                    scope=cgroup_scope(Path(f"/proc/{int(item['pid'])}/cgroup").read_text(),ident)
                    cpu=dict(line.split() for line in (scope/'cpu.stat').read_text().splitlines())
                    metric(lines,'offscript_container_cpu_seconds_total',int(cpu['usage_usec'])/1000000,name=name)
                    metric(lines,'offscript_container_memory_bytes',int((scope/'memory.current').read_text()),name=name)
                    maximum=(scope/'memory.max').read_text().strip()
                    if maximum!='max':metric(lines,'offscript_container_memory_limit_bytes',int(maximum),name=name)
                except (OSError,ValueError,KeyError):metric(lines,'offscript_container_cgroup_up',0,name=name)
                else:metric(lines,'offscript_container_cgroup_up',1,name=name)
        metric(lines,'offscript_docker_collection_up',1)
    except (OSError,ValueError,KeyError,subprocess.SubprocessError):metric(lines,'offscript_docker_collection_up',0)
    return lines

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    started=time.monotonic();lines=collect()
    metric(lines,'offscript_collector_last_success_timestamp_seconds',time.time())
    metric(lines,'offscript_collector_duration_seconds',time.monotonic()-started)
    target=args.output;temporary=target.with_suffix('.tmp')
    temporary.write_text('\n'.join(lines)+'\n');temporary.chmod(0o644);temporary.replace(target)

if __name__=='__main__':main()
