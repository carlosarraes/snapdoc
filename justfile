# snapdoc — build, test, deploy

binary_name := "snapdoc"
cli_dir := "./cli"
worker_dir := "./worker"
build_dir := "./build"
install_dir := env_var("HOME") / ".local/bin"

build_flags := "-trimpath"
ldflags := "-s -w"

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

# Remove build artifacts
clean:
    @rm -rf {{build_dir}} {{cli_dir}}/{{binary_name}}
