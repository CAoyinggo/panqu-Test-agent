# ── Stage 1: Builder ── 编译 TypeScript 源码
FROM node:24-alpine AS builder

WORKDIR /app

# 修复 OpenSSL CVE-2026-14456（HIGH）：libcrypto3/libssl3 须 >= 3.5.8-r0（Alpine 基础镜像层，非 Node 依赖）。
# 仅最小升级所需包；版本提取用 apk list --manifest（机器可读 "<name> <version>"，apk2/apk3 均稳定；
# apk-tools v3（Alpine 3.23+）已把 apk info 的版本行输出改为多行描述格式，无法再用于提取版本），
# 再用 Alpine 原生 apk version -t 比较（=/> 通过，</?/空值 fail），POSIX sh。
RUN set -eu; \
    apk upgrade --no-cache libcrypto3 libssl3; \
    MIN_VER="3.5.8-r0"; \
    for pkg in libcrypto3 libssl3; do \
      ver=$(apk list --installed --manifest "$pkg" 2>/dev/null | awk -v p="$pkg" '$1==p {print $2; exit}'); \
      if [ -z "$ver" ]; then \
        echo "ERROR: $pkg not installed or version empty"; exit 1; \
      fi; \
      rel=$(apk version -t "$ver" "$MIN_VER" 2>/dev/null || true); \
      case "$rel" in \
        =|\>) echo "OK: $pkg $ver >= $MIN_VER (rel=$rel)" ;; \
        *) echo "ERROR: $pkg $ver < $MIN_VER (rel='$rel')"; exit 1 ;; \
      esac; \
    done

# 复制依赖清单与 scripts/（npm ci 会执行根 prepare=node scripts/prepare.mjs，
# 必须在安装前就位，否则 MODULE_NOT_FOUND）
COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
RUN npm ci

# 复制源码 + 配置 + 其余内容，编译
COPY tsconfig.json ./
COPY src/ ./src/
COPY bin/ ./bin/
COPY tests/ ./tests/
RUN npm run build

# ── Stage 2: Runtime ── 仅保留编译产物 + 运行时依赖
FROM node:24-alpine AS runtime

WORKDIR /app

# 修复 OpenSSL CVE-2026-14456（HIGH）：libcrypto3/libssl3 须 >= 3.5.8-r0。
# 版本提取用 apk list --manifest（apk3 的 apk info 版本行已改为多行描述输出，无法再用于提取版本）。
RUN set -eu; \
    apk upgrade --no-cache libcrypto3 libssl3; \
    MIN_VER="3.5.8-r0"; \
    for pkg in libcrypto3 libssl3; do \
      ver=$(apk list --installed --manifest "$pkg" 2>/dev/null | awk -v p="$pkg" '$1==p {print $2; exit}'); \
      if [ -z "$ver" ]; then \
        echo "ERROR: $pkg not installed or version empty"; exit 1; \
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
