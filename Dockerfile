# 基础镜像：国内可改用镜像站，例如 docker.m.daocloud.io/library/node:22-alpine
ARG NODE_IMAGE=node:22-alpine

# ---------- 构建阶段：编译 TypeScript / 打包前端资源 ----------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS builder

# npm 源与 Alpine 源均可换成国内镜像（ALPINE_MIRROR 只填域名，不带协议）
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG ALPINE_MIRROR=
WORKDIR /source-code

RUN if [ -n "$ALPINE_MIRROR" ]; then \
      sed -i -e "s#https://dl-cdn.alpinelinux.org#https://${ALPINE_MIRROR}#g" \
             -e "s#http://dl-cdn.alpinelinux.org#https://${ALPINE_MIRROR}#g" /etc/apk/repositories; \
    fi \
 && (apk add --no-cache chromaprint || echo "chromaprint unavailable, fpcalc will be downloaded") \
 && npm config set registry "$NPM_REGISTRY"

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json tailwind.config.cjs ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY config.example.js index.js ./
RUN npm run build

# ---------- 生产依赖 ----------
FROM ${NODE_IMAGE} AS deps
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /deps
RUN npm config set registry "$NPM_REGISTRY"
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---------- 运行镜像 ----------
FROM ${NODE_IMAGE} AS final
ARG ALPINE_MIRROR=
WORKDIR /server

RUN if [ -n "$ALPINE_MIRROR" ]; then \
      sed -i -e "s#https://dl-cdn.alpinelinux.org#https://${ALPINE_MIRROR}#g" \
             -e "s#http://dl-cdn.alpinelinux.org#https://${ALPINE_MIRROR}#g" /etc/apk/repositories; \
    fi \
 && (apk add --no-cache chromaprint tzdata || echo "chromaprint unavailable, bundled fpcalc (if any) will be used") \
 && (node -e "const v=process.versions.node.split('.').map(Number); process.exit((v[0]>22||(v[0]===22&&v[1]>=13))?0:1)" \
     || { echo 'node >= 22.13 required for OpenList backup (node:sqlite)'; exit 1; })

COPY --from=deps /deps/node_modules ./node_modules
COPY --from=builder /source-code/server ./server
COPY --from=builder /source-code/public ./public
COPY --from=builder /source-code/config.example.js ./config.js
COPY --from=builder /source-code/index.js /source-code/package.json ./

RUN mkdir -p /server/data /server/music /server/cache
VOLUME ["/server/data", "/server/music", "/server/cache"]

ENV NODE_ENV=production \
    PORT=9527 \
    BIND_IP=0.0.0.0 \
    DATA_PATH=/server/data \
    LOG_PATH=/server/data/logs \
    TZ=Asia/Shanghai

EXPOSE 9527

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9527)+'/').then(()=>process.exit(0)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
