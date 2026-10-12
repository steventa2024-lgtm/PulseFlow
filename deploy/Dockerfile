FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
ENV PULSEFLOW_HOME=/data
ENV PULSEFLOW_HOST=0.0.0.0
ENV PULSEFLOW_ALLOW_REMOTE=1
EXPOSE 8787
VOLUME ["/data"]
CMD ["pnpm", "--filter", "@pulseflow/server", "exec", "tsx", "src/main.ts"]
