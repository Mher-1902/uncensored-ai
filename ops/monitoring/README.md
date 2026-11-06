# Private Samsung monitoring

Grafana OSS, Prometheus a textfile-only Node Exporter and a small Caddy proxy run on the Samsung. The Mac is a viewer, not the application host. Nothing uses a paid plan or external metrics service.

The dashboard is at `https://offscript-samsung-1.tail8c9a09.ts.net:8443/`. It requires membership in the owner's Tailscale network. Port 8443 must never be enabled in Funnel. The existing public chat route on 443 and private SSH route on 22 stay unchanged. On an iPad, install/sign in to Tailscale using the owner's existing network, enable it, then open this address in Safari. A home-screen shortcut can open the same page.

Anonymous Grafana access is read-only Viewer access **inside the private network**. There is no public signup, external snapshot service, monitoring cloud account or exposed Docker API. The randomly generated admin password is kept only in `/home/rog/dev/monitoring/secrets/admin-password`; never put it into Git, chat, URLs or logs. The dashboard has no container controls. Other authorized members of the tailnet can view these operational metrics.

## Data and resource budget

`collect.py` runs as the existing unprivileged Samsung user every 20 seconds. It selects host CPU, memory, disk, temperature, AC power, uptime, queue health and named operational containers. Docker reads use a fixed template without environment variables, commands, logs, prompts, replies or account identifiers. Cgroup reads use the actual Docker scope ancestor, including inherited memory limits. Prometheus receives an atomic sanitized textfile only. No monitoring container mounts the Docker socket, host `/proc`, host `/sys` or host root filesystem.

Grafana: 256 MiB / 0.15 CPU. Prometheus: 192 MiB / 0.10 CPU. Exporter: 48 MiB / 0.03 CPU. Proxy: 48 MiB / 0.03 CPU. Collector: 64 MiB / 5% CPU, 18-second deadline. Containers have no swap, dropped capabilities, bounded process/log counts and read-only roots. Prometheus retains at most 48 hours of samples with a 96 MB TSDB retention target; its WAL/head and image/volume overhead are additional. This is not a filesystem quota. Check disk usage and metric age rather than assuming monitoring is always present.

`images.lock.json` records verified upstream linux/amd64 manifests/config identities; Compose uses exact manifest digests. An installation receipt must verify the actual image IDs, resource limits, private route and fresh queries before this is considered installed. The dashboard does not measure tokens per second or establish simultaneous-user capacity.

## Operations

User services `offscript-metrics.timer` and `offscript-monitoring.service` start the collector and the four separate monitoring containers after boot. To stop monitoring, stop those two units. Production app/model containers are not part of this Compose project.

The Mac's Docker Desktop Containers page shows the Mac engine. Use the explicit SSH Docker context `offscript-samsung` for remote CLI inspection, e.g. `docker --context offscript-samsung ps`. Do not enable an unencrypted Docker TCP listener or switch the default context silently. Grafana provides the remote visual container view.

Existing private inference benchmark harnesses assert an exact three-container baseline. After installation, update their reviewed allowlist to include these four exact monitor containers and resource budgets before running them. A new background container must not be silently ignored.

Sources: [Grafana Docker](https://grafana.com/docs/grafana/latest/setup-grafana/installation/docker/), [Prometheus exporter](https://prometheus.io/docs/guides/node-exporter/), [private Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve), [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/).

The Samsung’s rootless internal network does not publish the Grafana port. A separate loopback-published Caddy proxy joins a viewer network and the internal metrics network. Grafana, Prometheus and the exporter retain internal-only networking. Unused bundled Grafana plugins are disabled to avoid unnecessary processes/RAM. The proxy reuses the exact existing local ingress image ID, separately instantiated with a new read-only proxy configuration; installing on another host requires building/verifying that ingress image first.
