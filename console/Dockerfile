# KSK review app — Bun server + the native `claude` CLI, run as a non-root user
# whose UID/GID matches the host so the bind-mounted credential file (see
# docker-compose.yml) is readable/writable without a chmod dance.
FROM oven/bun:1

ARG UID=1000
ARG GID=1000

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates poppler-utils \
  && rm -rf /var/lib/apt/lists/*

# oven/bun already ships a `bun` user at 1000:1000 — drop it so an arbitrary
# host UID/GID (including the common default 1000 itself) can be recreated
# cleanly as `app` without a UID/GID collision.
RUN userdel -r bun 2>/dev/null; groupdel bun 2>/dev/null; \
  groupadd -g ${GID} app \
  && useradd -m -u ${UID} -g ${GID} -s /bin/bash app

USER app
ENV HOME=/home/app
ENV PATH="${HOME}/.local/bin:${PATH}"

# Same native installer as the host (`installMethod: "native"`), so the
# credential file mounted in from ~/.claude/ is read by a matching CLI build.
RUN curl -fsSL https://claude.ai/install.sh | bash \
  && mkdir -p ${HOME}/.claude

WORKDIR /app

# Layered separately from the full COPY below so `bun install` only reruns
# when dependencies actually change — app/server.ts imports "xlsx" and "yaml"
# at runtime.
COPY --chown=app:app package.json bun.lock ./
RUN bun install --production

COPY --chown=app:app . .

# Documentation only: docker-compose.yml runs this with network_mode: host, so
# nothing is published through this. Matches KSK_APP_PORT's default.
EXPOSE 8940

CMD ["bun", "run", "app/server.ts"]
