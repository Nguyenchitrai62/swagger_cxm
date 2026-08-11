FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    MCP_ALLOWED_HOSTS=localhost,127.0.0.1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node config ./config
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const h=(process.env.MCP_ALLOWED_HOSTS||'127.0.0.1').split(',')[0].trim();require('node:http').get({hostname:'127.0.0.1',port:8000,path:'/healthz',headers:{Host:h}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["npm", "start"]
