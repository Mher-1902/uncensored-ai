import unittest
from unittest.mock import patch
from pathlib import Path
import collect

class MetricBoundaries(unittest.TestCase):
    def test_only_owned_operational_container_names_are_selected(self):
        for name in ['offscript-model-1','offscript-monitor-grafana','offscript-check-fixture-1']:
            self.assertTrue(collect.allowed(name))
        for name in ['postgres','other-app','offscript-model-1\nsecret','offscript-model-1"','../offscript-model-1','x'*500]:
            self.assertFalse(collect.allowed(name))

    def test_cpu_and_ram_use_parent_scope_not_init_leaf(self):
        ident='a'*64
        self.assertEqual(collect.cgroup_scope(f'0::/user.slice/user-1000.slice/docker-{ident}.scope/init\n',ident),Path(f'/sys/fs/cgroup/user.slice/user-1000.slice/docker-{ident}.scope'))

    def test_unrelated_or_escaping_cgroups_are_rejected(self):
        for value in ['0::/user.slice/other.scope/init','0::/../docker-'+('a'*64)+'.scope','1:cpu:/docker/'+('a'*64)]:
            with self.assertRaises(ValueError):collect.cgroup_scope(value,'a'*64)

    def test_metric_labels_cannot_inject_another_metric(self):
        lines=[];collect.metric(lines,'example',1,name='one"\ninjected 2')
        self.assertEqual(len(lines[0].splitlines()),1)
        self.assertIn('\\n',lines[0])
        with self.assertRaises(ValueError):collect.metric(lines,'example',float('nan'))

    def test_docker_reader_uses_explicit_rootless_socket_and_no_user_config(self):
        with patch('collect.os.geteuid',return_value=1000),patch('collect.subprocess.check_output',return_value='') as call:
            collect.docker(['ps','--format','{{.Names}}'])
        self.assertEqual(call.call_args.kwargs['env'],{'PATH':'/usr/bin:/bin','HOME':'/nonexistent','DOCKER_CONFIG':'/nonexistent','DOCKER_HOST':'unix:///run/user/1000/docker.sock'})
        self.assertEqual(call.call_args.kwargs['timeout'],4)

if __name__=='__main__':unittest.main()
