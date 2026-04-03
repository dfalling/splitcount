FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY src/ ./src
COPY migrations/ ./migrations
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
