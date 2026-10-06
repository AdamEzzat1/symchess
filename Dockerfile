# SymChess as one container: the Lisp engine serves the built frontend and the
# WebSocket on a single port. Runs anywhere that runs a Docker image
# (Hugging Face Spaces, Render, Koyeb, Fly, a laptop).
#
#   docker build -t symchess .
#   docker run --rm -p 7860:7860 symchess        then open http://localhost:7860

# ---------------------------------------------------------------- frontend
FROM node:26-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# -------------------------------------------------------------------- sbcl
# The official SBCL binary needs a newer glibc than Debian 12, which is what
# the SWI-Prolog image is built on. So SBCL is compiled here, on the same
# base, bootstrapped from Debian's own (older) SBCL.
FROM debian:bookworm-slim AS sbcl

ARG SBCL_VERSION=2.6.9
ARG SBCL_SHA256=c6fd1d735570eb4ff34caf9609988ca77ed0bd12b55d09a4fed075be890da513

RUN apt-get update  && apt-get install -y --no-install-recommends sbcl build-essential curl bzip2 ca-certificates  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://downloads.sourceforge.net/project/sbcl/sbcl/${SBCL_VERSION}/sbcl-${SBCL_VERSION}-source.tar.bz2" -o /tmp/sbcl.tar.bz2  && echo "${SBCL_SHA256}  /tmp/sbcl.tar.bz2" | sha256sum -c -  && tar -xjf /tmp/sbcl.tar.bz2 -C /tmp  && cd "/tmp/sbcl-${SBCL_VERSION}"  && sh make.sh --with-sb-thread  && INSTALL_ROOT=/opt/sbcl sh install.sh

# ----------------------------------------------------------------- runtime
FROM swipl:10.0.2

COPY --from=sbcl /opt/sbcl/bin/sbcl /usr/local/bin/sbcl
COPY --from=sbcl /opt/sbcl/lib/sbcl/ /usr/local/lib/sbcl/

# Unprivileged user (uid 1000 is also what Hugging Face Spaces runs as).
RUN useradd --create-home --uid 1000 app && mkdir -p /app/logs && chown -R app /app
USER app
ENV HOME=/home/app
WORKDIR /app

COPY --chown=app engine/ engine/
COPY --chown=app knowledge/ knowledge/
COPY --from=web --chown=app /src/web/dist/ web/dist/

# Compile the engine now so the container starts in a second or two.
RUN sbcl --non-interactive \
      --eval '(require :asdf)' \
      --eval '(asdf:load-asd #p"/app/engine/symchess.asd")' \
      --eval '(asdf:load-system "symchess")'

# Hosted defaults. The seat limit is what keeps a small free machine from
# being overwhelmed: visitor number nine is told to wait, not served badly.
ENV SYMCHESS_HOST=0.0.0.0 \
    PORT=7860 \
    SYMCHESS_MAX_SESSIONS=8 \
    SYMCHESS_IDLE_SECONDS=900 \
    SYMCHESS_ALLOWED_ORIGINS=* \
    SYMCHESS_MAX_DEPTH=7 \
    SYMCHESS_MAX_MOVE_MS=3000 \
    SYMCHESS_LOG=0

EXPOSE 7860
CMD ["sbcl", "--script", "engine/run.lisp"]
