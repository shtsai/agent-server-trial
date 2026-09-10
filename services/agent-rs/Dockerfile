# ONE Dockerfile for every platform. The Cargo project is self-contained under this directory, so
# the build context is this directory on all of them -- which is the whole reason the previous
# TypeScript service needed a second `Dockerfile.vercel`: npm workspaces forced a repo-root context
# that Vercel does not give a service.

FROM rust:1.96-slim AS build
WORKDIR /src

# Dependencies first, against a stub main, so a change to src/ does not recompile the world. This
# is the single biggest lever on the deploy-wall-time number the trial exists to measure.
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src

COPY src ./src
# cargo fingerprints on mtime, and the stub build left one for THIS crate. Without dropping its
# artifacts the second build is a no-op that ships the stub -- a container that starts, listens on
# nothing, and passes a health check by not existing.
RUN rm -f target/release/agent-rs target/release/deps/agent_rs* \
 && cargo build --release \
 && test -x target/release/agent-rs

FROM debian:bookworm-slim
# rustls verifies against the system roots; without these every call to api.anthropic.com fails
# with a TLS error that says nothing about certificates.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/agent-rs /usr/local/bin/agent-rs
# Both platforms inject $PORT; this is only the local default.
ENV PORT=3001
EXPOSE 3001
CMD ["agent-rs"]
