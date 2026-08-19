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
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/configs ./configs
USER node
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8000/ping').then(r=>r.text()).then(v=>{if(v.replace(/\"/g,'')!=='pong')process.exit(1)}).catch(()=>process.exit(1))"
CMD ["npm", "start"]
