FROM oven/bun:1.3.10-alpine

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/

RUN bun install --frozen-lockfile

VOLUME /config

EXPOSE 3000

CMD ["bun", "run", "apps/backend/src/index.ts"]
