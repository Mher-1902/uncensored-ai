FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG SITE_API_BASE
ARG SITE_ORIGIN
RUN npm run build

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/stream.ts ./src/stream.ts
COPY self-host/thermal.mjs ./self-host/thermal.mjs
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
