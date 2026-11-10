# The hosted populi-mcp server (remote MCP for Claude and ChatGPT connectors).
# An ordinary Node server listening on PORT; put it behind anything that terminates HTTPS.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY data ./data
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY data ./data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js", "--http"]
