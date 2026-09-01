# ── Stage 1: Builder ── 编译 TypeScript 源码
FROM node:24-alpine AS builder

WORKDIR /app

# 修复 OpenSSL CVE-2026-14456（HIGH）：libcrypto3/libssl3 须 >= 3.5.8-r0（Alpine 基础镜像层，非 Node 依赖）。
# 仅最小升级所需包；用 Alpine 原生 apk version -t 比较（读取输出，=/> 通过，</?/空值 fail），POSIX sh。
RUN set -eu; \
    apk upgrade --no-cache libcrypto3 libssl3; \
    MIN_VER="3.5.8-r0"; \
    for pkg in libcrypto3 libssl3; do \
      line=$(apk info -v "$pkg" 2>/dev/null || true); \
      ver=$(printf '%s' "$line" | sed -n "s/^$pkg-\([0-9][0-9.r-]*\).*/\1/p" | head -1); \
      if [ -z "$ver" ]; then \
        echo "ERROR: $pkg not installed or version empty (line='$line')"; exit 1; \
      fi; \
      rel=$(apk version -t "$ver" "$MIN_VER" 2>/dev/null || true); \
      case "$rel" in \
        =|\>) echo "OK: $pkg $ver >= $MIN_VER (rel=$rel)" ;; \
        *) echo "ERROR: $pkg $ver < $MIN_VER (rel='$rel')"; exit 1 ;; \
      esac; \
    done

# 复制依赖清单，安装全部依赖（含 devDependencies 用于编译）
COPY package.json package-lock.json ./
RUN npm ci

# 复制源码 + 配置 + 脚本，编译
COPY tsconfig.json ./
COPY src/ ./src/
COPY bin/ ./bin/
COPY scripts/ ./scripts/
COPY tests/ ./tests/
RUN npm run build

# ── Stage 2: Runtime ── 仅保留编译产物 + 运行时依赖
FROM node:24-alpine AS runtime

WORKDIR /app

# 修复 OpenSSL CVE-2026-14456（HIGH）：libcrypto3/libssl3 须 >= 3.5.8-r0。
RUN set -eu; \
    apk upgrade --no-cache libcrypto3 libssl3; \
    MIN_VER="3.5.8-r0"; \
    for pkg in libcrypto3 libssl3; do \
      line=$(apk info -v "$pkg" 2>/dev/null || true); \
      ver=$(printf '%s' "$line" | sed -n "s/^$pkg-\([0-9][0-9.r-]*\).*/\1/p" | head -1); \
      if [ -z "$ver" ]; then \
        echo "ERROR: $pkg not installed or version empty (line='$line')"; exit 1; \
      fi; \
      rel=$(apk version -t "$ver" "$MIN_VER" 2>/dev/null || true); \
      case "$rel" in \
        =|\>) echo "OK: $pkg $ver >= $MIN_VER (rel=$rel)" ;; \
        *) echo "ERROR: $pkg $ver < $MIN_VER (rel='$rel')"; exit 1 ;; \
      esac; \
    done

# 复制依赖清单，仅安装生产依赖；运行阶段只需 node，移除 npm/npx 以缩小攻击面
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

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
