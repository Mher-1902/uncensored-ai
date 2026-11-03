import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("recovery_proof", Path(__file__).resolve().parents[1] / "self-host/recovery_proof.py")
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)
BOOT = "11111111-1111-4111-8111-111111111111"
WORKER = "22222222-2222-4222-8222-222222222222"
START = "2026-10-20T06:00:00.123456789Z"
STOP = "2026-10-20T06:01:00.123456789Z"


class Fixture:
    def __init__(self):
        self.boot_id = BOOT
        self.protocol = 5
        self.workers = [WORKER, WORKER]
        self.values = {}
        self.processes = {101: 1001, 102: 1002}
        self.groups = {}
        for index, role in enumerate(("gateway", "model")):
            identifier = ("a" if index == 0 else "b") * 64
            self.values[role] = {"id": identifier, "running": True, "restarting": False, "paused": False, "dead": False,
                                 "pid": 101 + index, "startedAt": START, "finishedAt": "0001-01-01T00:00:00Z"}
            self.groups[identifier] = "/user.slice/docker-" + identifier + ".scope"
        self.group_values = {group: None for group in self.groups.values()}

    def boot(self):
        return self.boot_id

    def inspect(self, target):
        role = target.removeprefix("offscript-").removesuffix("-1")
        value = self.values.get(role) or next(value for value in self.values.values() if value["id"] == target)
        return copy.deepcopy(value)

    def worker(self, _container):
        return {"protocol": self.protocol, "workerId": self.workers.pop(0) if len(self.workers) > 1 else self.workers[0]}

    def process(self, pid):
        return self.processes.get(pid)

    def group(self, pid):
        return self.groups[next(value["id"] for value in self.values.values() if value["pid"] == pid)]

    def group_state(self, group):
        return self.group_values[group]

    def stop(self):
        for value in self.values.values():
            value.update(running=False, pid=0, finishedAt=STOP)
        self.processes.clear()


class RecoveryProofTests(unittest.TestCase):
    def test_worker_capture_uses_rust_cli_without_requiring_node(self):
        environment=proof.Environment()
        expected={"protocol":5,"workerId":WORKER}
        with patch.object(environment,"docker",side_effect=["",json.dumps(expected)]) as docker:
            self.assertEqual(environment.worker("a"*64),expected)
        self.assertEqual(docker.call_args_list[-1].args[0][-2:],["/usr/local/bin/offscript-backend","worker-evidence"])

    def test_absent_rust_binary_uses_existing_node_capture_but_other_failures_do_not_fallback(self):
        environment=proof.Environment();expected={"protocol":5,"workerId":WORKER}
        missing=proof.subprocess.CalledProcessError(1,["test"])
        with patch.object(environment,"docker",side_effect=[missing,json.dumps(expected)]) as docker:
            self.assertEqual(environment.worker("a"*64),expected)
        self.assertEqual(docker.call_args_list[-1].args[0][-3:-1],["/usr/local/bin/node","--eval"])
        for responses in ([proof.subprocess.CalledProcessError(125,["docker"])],["",proof.subprocess.CalledProcessError(1,["worker-evidence"])]):
            with patch.object(environment,"docker",side_effect=responses) as docker:
                with self.assertRaises(proof.subprocess.CalledProcessError):environment.worker("a"*64)
                self.assertEqual(docker.call_count,len(responses))

    def test_stopped_pair_proves_only_the_captured_worker_without_database_changes(self):
        fixture = Fixture()
        evidence = proof.capture(fixture)
        self.assertEqual(evidence["workerId"], WORKER)
        fixture.stop()
        self.assertEqual(proof.verify(fixture, evidence), {"schema": 1, "stopped": True, "databaseChanged": False})

    def test_running_peer_restart_and_live_old_process_never_pass(self):
        for variant in ("model", "gateway", "restart", "process", "boot", "removed"):
            with self.subTest(variant=variant):
                fixture = Fixture()
                evidence = proof.capture(fixture)
                fixture.stop()
                if variant in ("model", "gateway"):
                    fixture.values[variant].update(running=True, pid=999)
                elif variant == "restart":
                    fixture.values["gateway"]["startedAt"] = STOP
                elif variant == "process":
                    fixture.processes[101] = 1001
                elif variant == "boot":
                    fixture.boot_id = WORKER
                else:
                    del fixture.values["model"]
                with self.assertRaises(Exception):
                    proof.verify(fixture, evidence)

    def test_descendant_cgroup_tasks_and_permission_failures_do_not_count_as_cleanup(self):
        for group_state in ({"events": "populated 1\n", "processes": ""}, {"events": "populated 0\n", "processes": "99\n"}, {"events": "frozen 0\n", "processes": ""}):
            fixture = Fixture()
            evidence = proof.capture(fixture)
            fixture.stop()
            fixture.group_values[fixture.groups["a" * 64]] = group_state
            with self.assertRaises(proof.ProofError):
                proof.verify(fixture, evidence)
        fixture = Fixture()
        evidence = proof.capture(fixture)
        fixture.stop()
        with patch.object(fixture, "process", side_effect=PermissionError()):
            with self.assertRaises(PermissionError):
                proof.verify(fixture, evidence)

    def test_pid_reuse_and_empty_cgroup_do_not_confuse_a_new_process_with_the_old_one(self):
        fixture = Fixture()
        evidence = proof.capture(fixture)
        fixture.stop()
        fixture.processes[101] = 9999
        fixture.group_values[fixture.groups["a" * 64]] = {"events": "populated 0\nfrozen 0\n", "processes": ""}
        self.assertTrue(proof.verify(fixture, evidence)["stopped"])

    def test_capture_requires_protocol_five_and_one_stable_worker(self):
        fixture = Fixture()
        fixture.protocol = 4
        with self.assertRaises(proof.ProofError):
            proof.capture(fixture)
        fixture = Fixture()
        fixture.workers[1] = BOOT
        with self.assertRaises(proof.ProofError):
            proof.capture(fixture)

    def test_malformed_evidence_and_cgroup_path_escape_fail_before_any_success(self):
        for mutate in (lambda x: x.update(schema=True), lambda x: x.update(workerId="unknown"),
                       lambda x: x["containers"]["model"].update(id="a" * 64),
                       lambda x: x["containers"]["model"].update(startTicks=True),
                       lambda x: x["containers"]["model"].update(cgroup="/../docker-" + "b" * 64)):
            fixture = Fixture()
            evidence = proof.capture(fixture)
            fixture.stop()
            mutate(evidence)
            with self.assertRaises(proof.ProofError):
                proof.verify(fixture, evidence)

    def test_private_evidence_file_preserves_existing_files_and_rejects_links_or_duplicate_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "proof.json"
            evidence = proof.capture(Fixture())
            proof.save(path, evidence)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(proof.load(path), evidence)
            with self.assertRaises(FileExistsError):
                proof.save(path, {})
            self.assertEqual(proof.load(path), evidence)
            link = Path(directory) / "link"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                proof.load(link)
            path.chmod(0o644)
            with self.assertRaises(proof.ProofError):
                proof.load(path)
            path.chmod(0o600)
            path.write_text('{"schema":1,"schema":1}')
            with self.assertRaises(proof.ProofError):
                proof.load(path)
            (Path(directory) / ".git").write_text("gitdir: dummy")
            with self.assertRaises(proof.ProofError):
                proof.save(Path(directory) / "other.json", evidence)

    def test_process_parser_handles_parentheses_without_accepting_another_pid(self):
        value = "101 (node ) worker) " + " ".join(["S"] + ["0"] * 18 + ["1001"])
        self.assertEqual(proof.start_ticks(value, 101), 1001)
        with self.assertRaises(proof.ProofError):
            proof.start_ticks(value, 102)

    def test_docker_reads_use_only_the_rootless_socket_and_empty_private_configuration(self):
        response = type("Result", (), {"stdout": b"{}"})()
        with patch.object(proof.subprocess, "run", return_value=response) as run:
            proof.Environment().inspect("a" * 64)
        command = run.call_args.args[0]
        self.assertEqual(command[:3], ["/usr/bin/docker", "--host", f"unix:///run/user/{os.getuid()}/docker.sock"])
        self.assertEqual(command[-1], "a" * 64)
        self.assertEqual(run.call_args.kwargs["env"], {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "DOCKER_CONFIG": "/nonexistent"})
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_cli_never_echoes_unexpected_runtime_or_credential_diagnostics(self):
        output = io.StringIO()
        with patch.object(sys, "argv", ["recovery_proof.py", "--verify", "private.json"]), \
                patch.object(proof, "load", side_effect=RuntimeError("dummy-private-credential")), contextlib.redirect_stdout(output):
            result = proof.main()
        self.assertEqual(result, 1)
        self.assertNotIn("dummy-private-credential", output.getvalue())
        self.assertFalse(json.loads(output.getvalue())["stopped"])


if __name__ == "__main__":
    unittest.main()
