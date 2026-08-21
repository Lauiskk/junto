# Build a partir da raiz do monorepo:
#   docker build -f server/signaling/Dockerfile .
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY server/signaling/package.json server/signaling/

# Instala so o que o servidor precisa — sem Electron, sem React.
RUN npm ci --include-workspace-root \
    --workspace @junto/protocol \
    --workspace @junto/signaling

COPY packages/protocol packages/protocol
COPY server/signaling server/signaling

RUN npx tsc -b packages/protocol server/signaling

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/protocol packages/protocol
COPY --from=build /app/server/signaling server/signaling

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/signaling/dist/index.js"]
