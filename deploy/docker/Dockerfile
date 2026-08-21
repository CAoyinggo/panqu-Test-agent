# ── Stage 1: Builder ── 编译 TypeScript 源码
FROM node:20-alpine AS builder

WORKDIR /app

# 复制依赖清单，安装全部依赖（含 devDependencies 用于编译）
COPY package.json package-lock.json ./
RUN npm ci

# 复制源码 + 配置 + 脚本，编译
COPY tsconfig.json ./
COPY src/ ./src/
COPY bin/ ./bin/
COPY scripts/ ./scripts/
RUN npm run build

# ── Stage 2: Runtime ── 仅保留编译产物 + 运行时依赖
FROM node:20-alpine AS runtime

WORKDIR /app

# 复制依赖清单，仅安装生产依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# 复制编译产物 + 配置 + 用例
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/src/cases/ ./src/cases/
COPY --from=builder /app/src/config/environments.json ./dist/src/config/environments.json

# 创建输出目录（挂载点）
RUN mkdir -p /app/output

# 环境变量默认值
ENV TESTFLOW_ENV=test
ENV NODE_ENV=production
ENV TESTFLOW_OUTPUT_DIR=/app/output
ENV TESTFLOW_ASSETS_DIR=/app/assets

# 入口点
ENTRYPOINT ["node", "dist/bin/run-test.js"]

# 默认命令（可通过 docker run 覆盖）
CMD ["--task", "src/cases", "--ci"]
