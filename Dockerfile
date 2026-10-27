FROM docker.m.daocloud.io/library/node:24-alpine

WORKDIR /app
ENV TZ=Asia/Shanghai

# Dependencies (including the official baw CLI: @binance/agentic-wallet); use npmmirror for faster downloads.
COPY package*.json ./
RUN npm install --omit=dev --no-fund --no-audit --registry=https://registry.npmmirror.com

# Application files (.env / data / logs / baw session are mounted as volumes and are not included in the image).
COPY src ./src
COPY scripts ./scripts
COPY probe-stream.mjs ./

CMD ["node", "src/index.js"]
