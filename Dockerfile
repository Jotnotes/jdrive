# JotNotes JDrive in a container.
#
# The install script is the supported path and this is the documented
# alternative, exactly as item 0g settled it: every hosting company can run a
# script, not all of them run containers, and the panels this competes with all
# install by script. Use this if you already run containers and would rather not
# have a systemd unit.
#
# Two things are different in here and both matter.
#
# BIND_HOST=0.0.0.0. Loopback inside a container is the container's own, so a
# published port would reach nothing and the box could not be run this way at
# all. The container's network is then the boundary that the reverse proxy is on
# metal — so put a proxy in front of it and do not publish this port to the
# world. The box still does not terminate TLS.
#
# The bootstrap port is not published and cannot be. It mints the account that
# runs the box, and it stays on the container's loopback where the one-time
# `docker exec` that creates the operator can reach it and nothing else can.
#
# Build:   docker build -t jdrive .
# Run:     see docs/INSTALL.md — it needs a volume and a secret, and the first
#          account is created with one `docker exec` afterwards.

# Built from a release, which arrives with the interface already compiled and the
# server compiled into single files. Only the dependencies are installed here. A
# checkout of the repository has to build web/dist first (cd web && npm ci && npm run
# build) — the release does that for you.
FROM node:20-bookworm-slim
RUN useradd --system --home-dir /var/lib/jdrive --shell /usr/sbin/nologin jdrive \
 && mkdir -p /var/lib/jdrive/{data,uploads,backups,archives} \
 && chown -R jdrive:jdrive /var/lib/jdrive
WORKDIR /opt/jdrive
COPY --chown=root:root server/package*.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund
COPY --chown=root:root server ./server
COPY --chown=root:root web/dist ./web/dist
COPY --chown=root:root docs ./docs

ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    PORT=9990 \
    BOOTSTRAP_PORT=9991 \
    DATA_DIR=/var/lib/jdrive/data \
    UPLOADS_DIR=/var/lib/jdrive/uploads \
    BACKUPS_DIR=/var/lib/jdrive/backups \
    ARCHIVES_DIR=/var/lib/jdrive/archives \
    WEB_DIST=/opt/jdrive/web/dist

# The product. Everything a customer would miss is under here, and it is the one
# thing to back up.
VOLUME /var/lib/jdrive

# JWT_SECRET is deliberately not set. A secret baked into an image is a secret
# every copy of that image shares, so the box refuses to start without one and
# that refusal is correct — pass it at run time.
USER jdrive
EXPOSE 9990
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||9990)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
WORKDIR /opt/jdrive/server
CMD ["node", "server.js"]
