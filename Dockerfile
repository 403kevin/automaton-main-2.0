FROM node:22-bookworm-slim

WORKDIR /app

# The client has to speak to a current dockerd. Debian's docker.io package is too old.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl \
  && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz \
    | tar -xz -C /tmp \
  && mv /tmp/docker/docker /usr/local/bin/docker \
  && rm -rf /tmp/docker \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json constitution.md ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 4747

CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js", "serve"]
