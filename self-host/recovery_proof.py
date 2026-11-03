"""Read-only recovery evidence. Never stops workers or changes database state."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ID = re.compile(r"^[0-9a-f]{64}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
STATE_TEMPLATE = ('{"id":{{json .Id}},"running":{{json .State.Running}},'
                  '"restarting":{{json .State.Restarting}},"paused":{{json .State.Paused}},'
                  '"dead":{{json .State.Dead}},"pid":{{json .State.Pid}},'
                  '"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}}}')


class ProofError(Exception):
    """Only fixed reason codes are suitable for CLI output."""


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z", value):
        raise ProofError("invalid_evidence")
    value = re.sub(r"\.(\d{6})\d+Z$", r".\1Z", value)
    return datetime.datetime.fromisoformat(value[:-1] + "+00:00")


def cgroup_path(value, container):
    if not isinstance(value, str) or not value.startswith("/") or container not in value:
        raise ProofError("unidentified_cgroup")
    if any(part in ("", ".", "..") for part in value[1:].split("/")) or not re.fullmatch(r"/[A-Za-z0-9_.:@/-]+", value):
        raise ProofError("unidentified_cgroup")
    return value


def start_ticks(text, pid):
    if not text.startswith(str(pid) + " (") or ")" not in text:
        raise ProofError("unidentified_process")
    fields = text.rsplit(")", 1)[1].split()
    if len(fields) < 20 or not fields[19].isdigit() or int(fields[19]) <= 0:
        raise ProofError("unidentified_process")
    return int(fields[19])


class Environment:
    def docker(self, arguments):
        # Explicit rootless socket and empty configuration avoid loading registry
        # credentials or permitting a context/remote-daemon override.
        command = ["/usr/bin/docker", "--host", f"unix:///run/user/{os.getuid()}/docker.sock", *arguments]
        result = subprocess.run(command, capture_output=True, timeout=5, check=True,
                                env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "DOCKER_CONFIG": "/nonexistent"})
        if len(result.stdout) > 16384:
            raise ProofError("invalid_runtime_response")
        return result.stdout.decode("utf8")

    def inspect(self, target):
        return json.loads(self.docker(["inspect", "--format", STATE_TEMPLATE, target]))

    def worker(self, container):
        prefix = ["exec", container, "/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp"]
        try:
            self.docker([*prefix, "/usr/bin/test", "-x", "/usr/local/bin/offscript-backend"])
        except subprocess.CalledProcessError as error:
            if error.returncode != 1:
                raise
        else:
            # The Rust image has no Node interpreter. Never fall back after a
            # present Rust CLI reports invalid evidence or a runtime failure.
            return json.loads(self.docker([*prefix, "/usr/local/bin/offscript-backend", "worker-evidence"]))
        code = ("fetch('http://127.0.0.1:8080/api/health',{signal:AbortSignal.timeout(2000)})"
                ".then(r=>r.json()).then(v=>console.log(JSON.stringify({protocol:v.protocol,workerId:v.workerId})))"
                ".catch(()=>process.exit(1))")
        return json.loads(self.docker([*prefix, "/usr/local/bin/node", "--eval", code]))

    def boot(self):
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()

    def process(self, pid):
        try:
            return start_ticks(Path(f"/proc/{pid}/stat").read_text(), pid)
        except FileNotFoundError:
            return None

    def group(self, pid):
        lines = Path(f"/proc/{pid}/cgroup").read_text().splitlines()
        if len(lines) != 1 or not lines[0].startswith("0::"):
            raise ProofError("unsupported_cgroup")
        return lines[0][3:]

    def group_state(self, group):
        directory = Path("/sys/fs/cgroup") / group.lstrip("/")
        try:
            if not stat.S_ISDIR(directory.stat().st_mode):
                raise ProofError("unidentified_cgroup")
        except FileNotFoundError:
            return None
        return {"events": (directory / "cgroup.events").read_text(), "processes": (directory / "cgroup.procs").read_text()}


def state(value):
    if not isinstance(value, dict) or not ID.fullmatch(str(value.get("id", ""))):
        raise ProofError("invalid_runtime_response")
    if any(type(value.get(key)) is not bool for key in ("running", "restarting", "paused", "dead")):
        raise ProofError("invalid_runtime_response")
    if type(value.get("pid")) is not int or not 0 <= value["pid"] < 2**31:
        raise ProofError("invalid_runtime_response")
    timestamp(value.get("startedAt"))
    return value


def capture(environment):
    boot = environment.boot()
    if not UUID.fullmatch(boot):
        raise ProofError("unidentified_boot")
    first = {key: state(environment.inspect("offscript-" + key + "-1")) for key in ("gateway", "model")}
    if first["gateway"]["id"] == first["model"]["id"] or first["gateway"]["pid"] == first["model"]["pid"]:
        raise ProofError("invalid_runtime_response")
    worker = environment.worker(first["gateway"]["id"])
    if worker.get("protocol") != 5 or not UUID.fullmatch(str(worker.get("workerId", ""))):
        raise ProofError("unsupported_worker")
    containers = {}
    for key, value in first.items():
        if not value["running"] or value["restarting"] or value["paused"] or value["dead"] or value["pid"] == 0:
            raise ProofError("worker_not_running")
        ticks = environment.process(value["pid"])
        if ticks is None:
            raise ProofError("runtime_changed")
        group = cgroup_path(environment.group(value["pid"]), value["id"])
        containers[key] = {"id": value["id"], "pid": value["pid"], "startedAt": value["startedAt"], "startTicks": ticks, "cgroup": group}
        if state(environment.inspect(value["id"])) != value:
            raise ProofError("runtime_changed")
    if environment.boot() != boot or environment.worker(first["gateway"]["id"]) != worker:
        raise ProofError("runtime_changed")
    return {"schema": 1, "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "bootId": boot, "workerId": worker["workerId"], "containers": containers}


def verify(environment, evidence):
    if not isinstance(evidence, dict) or set(evidence) != {"schema", "capturedAt", "bootId", "workerId", "containers"} or type(evidence["schema"]) is not int or evidence["schema"] != 1:
        raise ProofError("invalid_evidence")
    timestamp(evidence["capturedAt"])
    if not UUID.fullmatch(str(evidence["workerId"])) or not UUID.fullmatch(str(evidence["bootId"])):
        raise ProofError("invalid_evidence")
    if environment.boot() != evidence["bootId"]:
        raise ProofError("boot_changed")
    containers = evidence["containers"]
    if not isinstance(containers, dict) or set(containers) != {"gateway", "model"}:
        raise ProofError("invalid_evidence")
    seen = set()
    for previous in containers.values():
        if not isinstance(previous, dict) or set(previous) != {"id", "pid", "startedAt", "startTicks", "cgroup"}:
            raise ProofError("invalid_evidence")
        if not ID.fullmatch(str(previous["id"])) or previous["id"] in seen or type(previous["pid"]) is not int or not 0 < previous["pid"] < 2**31:
            raise ProofError("invalid_evidence")
        seen.add(previous["id"])
        if type(previous["startTicks"]) is not int or previous["startTicks"] <= 0:
            raise ProofError("invalid_evidence")
        group = cgroup_path(previous["cgroup"], previous["id"])
        current = state(environment.inspect(previous["id"]))
        if current["id"] != previous["id"] or current["startedAt"] != previous["startedAt"]:
            raise ProofError("runtime_changed")
        if current["running"] or current["restarting"] or current["paused"] or current["dead"] or current["pid"] != 0:
            raise ProofError("worker_still_running")
        if timestamp(current["finishedAt"]) < timestamp(previous["startedAt"]):
            raise ProofError("invalid_runtime_response")
        if environment.process(previous["pid"]) == previous["startTicks"]:
            raise ProofError("process_still_running")
        remaining = environment.group_state(group)
        if remaining is not None:
            events = dict(line.split() for line in remaining["events"].splitlines())
            if events.get("populated") != "0" or remaining["processes"].strip():
                raise ProofError("cgroup_still_running")
        # Do not accept a stopped state that changed during process/cgroup checks.
        if state(environment.inspect(previous["id"])) != current:
            raise ProofError("runtime_changed")
    if environment.boot() != evidence["bootId"]:
        raise ProofError("runtime_changed")
    return {"schema": 1, "stopped": True, "databaseChanged": False}


def private_parent(path):
    parent = Path(path).absolute().parent.resolve()
    metadata = parent.stat()
    if metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
        raise ProofError("insecure_evidence_location")
    if any((directory / ".git").exists() for directory in (parent, *parent.parents)):
        raise ProofError("evidence_inside_repository")


def save(path, evidence):
    private_parent(path)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(evidence, output, indent=2)
        output.write("\n")


def load(path):
    def unique(pairs):
        result = dict(pairs)
        if len(result) != len(pairs):
            raise ProofError("invalid_evidence")
        return result

    private_parent(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor) as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077 or metadata.st_size > 16384:
            raise ProofError("insecure_evidence_file")
        return json.loads(source.read(16385), object_pairs_hook=unique)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--capture", metavar="PRIVATE_FILE")
    mode.add_argument("--verify", metavar="PRIVATE_FILE")
    args = parser.parse_args()
    try:
        environment = Environment()
        if args.capture:
            private_parent(args.capture)
            save(args.capture, capture(environment))
            result = {"captured": True, "stopped": False, "databaseChanged": False}
        else:
            result = verify(environment, load(args.verify))
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({"stopped": False, "databaseChanged": False,
                          "reason": str(error) if isinstance(error, ProofError) else "verification_unavailable"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
