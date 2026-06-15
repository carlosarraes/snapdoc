# snapdoc — build, test, deploy

binary_name := "snapdoc"
cli_dir := "./cli"
worker_dir := "./worker"
build_dir := "./build"
install_dir := env_var("HOME") / ".local/bin"

# Single source of truth for the version (bumped by `just release`).
version := `cat VERSION 2>/dev/null || echo dev`
version_pkg := "github.com/carlosarraes/snapdoc/cli/internal/version"

build_flags := "-trimpath"
ldflags := "-s -w -X " + version_pkg + ".Version=" + version

# Default recipe
default: build

# Build the CLI (optimized) and copy to ~/.local/bin
build:
    @echo "Building {{binary_name}}..."
    @mkdir -p {{build_dir}}
    @go build {{build_flags}} -ldflags "{{ldflags}}" -o {{build_dir}}/{{binary_name}} {{cli_dir}}
    @mkdir -p {{install_dir}}
    @cp {{build_dir}}/{{binary_name}} {{install_dir}}/
    @echo "Installed {{install_dir}}/{{binary_name}}"

# Run all tests (CLI + worker)
test: test-cli test-worker

# Run Go CLI tests
test-cli:
    @go test {{cli_dir}}/...

# Run worker tests (vitest + workers pool)
test-worker:
    @cd {{worker_dir}} && npm test

# Format and vet the Go code
check:
    @go fmt {{cli_dir}}/... && go vet {{cli_dir}}/...
    @cd {{worker_dir}} && npx tsc --noEmit

# Run the worker locally
dev:
    @cd {{worker_dir}} && npm run dev

# Apply schema to the local D1 database
migrate-local:
    @cd {{worker_dir}} && npm run db:migrate:local

# Apply schema to the remote D1 database
migrate-remote:
    @cd {{worker_dir}} && npm run db:migrate:remote

# Deploy the worker (uploads public/ assets too)
deploy:
    @cd {{worker_dir}} && npx wrangler deploy

# Print the current version
version:
    @echo {{version}}

# Cut a release: bump VERSION, commit, tag vX.Y.Z, and push (CI builds binaries).
# Usage: just release 0.0.2
release new_version:
    #!/usr/bin/env bash
    set -euo pipefail
    ver="{{new_version}}"; ver="${ver#v}"
    if ! printf '%s' "$ver" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        echo "error: version must be semver like 0.0.2 (got '{{new_version}}')" >&2
        exit 1
    fi
    if [ -n "$(git status --porcelain)" ]; then
        echo "error: working tree is dirty; commit or stash first" >&2
        exit 1
    fi
    if git rev-parse "v$ver" >/dev/null 2>&1; then
        echo "error: tag v$ver already exists" >&2
        exit 1
    fi
    go test {{cli_dir}}/...
    printf '%s\n' "$ver" > VERSION
    git add VERSION
    git commit -m "chore: release v$ver"
    git tag -a "v$ver" -m "v$ver"
    git push origin HEAD
    git push origin "v$ver"
    echo "Pushed v$ver — GitHub Actions will build and publish the release."

# Remove build artifacts
clean:
    @rm -rf {{build_dir}} {{cli_dir}}/{{binary_name}}
