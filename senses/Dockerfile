# The image tag matches playwright in package.json. Browsers are already in the image.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PORT=7070
ENV NODE_ENV=production
ENV HOME=/tmp

COPY senses/package.json senses/package-lock.json ./
RUN npm ci --omit=dev

COPY senses/src ./src
# Host deny checks reuse the orchestrator's constitution module when this file is present.
COPY src/constitution.ts /src/constitution.ts
COPY constitution.md /constitution.md

USER pwuser
EXPOSE 7070

CMD ["node", "src/server.ts"]
