FROM caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f
# Port 8080 needs no bind capability; remove the official binary's low-port capability.
RUN setcap -r /usr/bin/caddy
COPY --chown=65532:65532 docker/Caddyfile /etc/caddy/Caddyfile
USER 65532:65532
