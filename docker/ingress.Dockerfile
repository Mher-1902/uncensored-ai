FROM caddy:2.11.9-alpine@sha256:0bbb055bda6793c999bde78b1b5ce3e89f829fb031af2cf50056ea1246559fee
# Port 8080 needs no bind capability; remove the official binary's low-port capability.
RUN setcap -r /usr/bin/caddy
COPY --chown=65532:65532 docker/Caddyfile /etc/caddy/Caddyfile
USER 65532:65532
