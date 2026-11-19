# The image tag matches playwright in package.json. Browsers are already in the image.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PORT=7070
ENV NODE_ENV=production
ENV HOME=/tmp
ENV BROWSE_PYTHON=/opt/browse-venv/bin/python
# browser-use telemetry switch. Docs: https://docs.browser-use.com/open-source/telemetry
ENV ANONYMIZED_TELEMETRY=false

COPY senses/package.json senses/package-lock.json ./
RUN npm ci --omit=dev

COPY senses/requirements.browse.txt /tmp/requirements.browse.txt
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
 && python3 -m venv /opt/browse-venv \
 && /opt/browse-venv/bin/pip install --no-cache-dir -r /tmp/requirements.browse.txt \
 && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/requirements.browse.txt

COPY senses/src ./src
COPY senses/browse.py ./browse.py
# Host deny checks reuse the orchestrator's constitution module when this file is present.
COPY src/constitution.ts /src/constitution.ts
COPY constitution.md /constitution.md

USER pwuser
EXPOSE 7070

CMD ["node", "src/server.ts"]
