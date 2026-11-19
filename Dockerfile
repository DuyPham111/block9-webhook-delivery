# Một image dùng chung cho sender-api, relay, receiver-api và receiver-worker;
# mỗi service chỉ khác lệnh chạy (xem docker-compose.yml).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY shared ./shared
COPY services ./services
