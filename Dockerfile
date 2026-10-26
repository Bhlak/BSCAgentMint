FROM docker.m.daocloud.io/library/node:24-alpine

WORKDIR /app
ENV TZ=Asia/Shanghai

# 依赖（含官方 baw CLI：@binance/agentic-wallet）；npmmirror 加速
COPY package*.json ./
RUN npm install --omit=dev --no-fund --no-audit --registry=https://registry.npmmirror.com

# 代码（.env / data / logs / baw 会话全部走卷挂载，不进镜像）
COPY src ./src
COPY scripts ./scripts
COPY probe-stream.mjs ./

CMD ["node", "src/index.js"]
