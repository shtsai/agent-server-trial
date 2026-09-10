# Deliberately NOT a package.json. The repo root holds no manifest of any kind, because a root
# package.json is bait: Railway's builder autodetects from the root when a service's Root Directory
# is unset, finds it, decides the whole repo is a Node app, and fails with "No start command
# detected" -- a Node error for a Rust service, which sends you looking in the wrong place. Nothing
# at this level should look like an app.

.PHONY: dev web agent build
dev:
	@$(MAKE) -j2 web agent
web:
	cd web && npm run dev
agent:
	cargo run --manifest-path services/agent-rs/Cargo.toml
build:
	cd web && npm run build
	cargo build --release --manifest-path services/agent-rs/Cargo.toml
