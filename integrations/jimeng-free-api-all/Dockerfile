# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:20.20.2-bookworm

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json libs.d.ts ./
COPY configs ./configs
COPY public ./public
COPY src ./src

FROM build AS test
COPY tests ./tests
COPY patches/scripts ./patches/scripts
RUN node -e "const p=require('./package.json');const npm=require('node:child_process').execFileSync('npm',['--version'],{encoding:'utf8'}).trim();if(process.versions.node!==p.engines.node||npm!==p.engines.npm)throw new Error('Node/npm version mismatch')"
RUN --network=none npm test

FROM test AS compiled
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    IMAGE_TASK_STORE_DIR=/app/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright-core install --with-deps chromium \
    && npm cache clean --force \
    && mkdir -p /app/data \
    && chown -R node:node /app /ms-playwright
COPY --from=compiled --chown=node:node /app/dist ./dist
COPY --from=compiled --chown=node:node /app/configs ./configs
COPY --from=compiled --chown=node:node /app/public ./public
COPY --from=test --chown=node:node /app/patches/scripts/jimeng-volume.cjs ./deployment/jimeng-volume.cjs
COPY --from=test --chown=node:node /app/src/api/services/image-task-archive.mjs ./deployment/image-task-archive.mjs
LABEL org.merchroute.jimeng.archive-schema="1"
USER node
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "Promise.all([fetch('http://127.0.0.1:8000/ping').then(async r=>{if(!r.ok||(await r.text()).replace(/\"/g,'')!=='pong')throw new Error('ping')}),fetch('http://127.0.0.1:8000/').then(async r=>{const b=await r.text();if(!r.ok||!(r.headers.get('content-type')||'').includes('text/html')||!b.includes('jimeng-free-api'))throw new Error('welcome')})]).catch(()=>process.exit(1))"
CMD ["npm", "start"]
