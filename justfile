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

# Run the dashboard dev server (Vite + HMR; proxies /v1 to `just dev` on :8787)
dashboard-dev:
    @cd dashboard && npm run dev

# Build the dashboard SPA into the worker's static assets (worker/public/admin)
dashboard-build:
    @cd dashboard && npm run build

# Build the review page + annotator into the worker's static assets (worker/public/review)
review-build:
    @cd review && npm run build

# Apply schema to the local D1 database
migrate-local:
    @cd {{worker_dir}} && npm run db:migrate:local

# Apply schema to the remote D1 database
migrate-remote:
    @cd {{worker_dir}} && npm run db:migrate:remote

# Deploy the worker (builds the dashboard + review page, then uploads public/ assets too)
deploy: dashboard-build review-build
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
    if git diff --cached --quiet; then
        echo "VERSION already at $ver; tagging the current commit"
    else
        git commit -m "chore: release v$ver"
    fi
    git tag -a "v$ver" -m "v$ver"
    git push origin HEAD
    git push origin "v$ver"
    echo "Pushed v$ver — GitHub Actions will build and publish the release."

# Remove build artifacts
clean:
    @rm -rf {{build_dir}} {{cli_dir}}/{{binary_name}}

# ---- Android companion app (android/) ----

android_dir := "./android"
android_apk := "android/app/build/outputs/apk/debug/app-debug.apk"
app_id := "dev.carraes.snapdoc"
# `java` on this machine is an asdf shim with no version pinned, so recipes
# point Gradle at a real JDK themselves.
java_home := env_var_or_default("JAVA_HOME", env_var("HOME") / ".asdf/installs/java/temurin-17.0.19+10")

# One-time: install the Android SDK packages, write local.properties, fetch the wrapper.
android-bootstrap:
    @scripts/bootstrap-android.sh

# Build the debug APK.
android-build:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -f {{android_dir}}/local.properties ]; then
        echo "android/local.properties is missing — run: just android-bootstrap" >&2
        exit 1
    fi
    JAVA_HOME="{{java_home}}" {{android_dir}}/gradlew -p {{android_dir}} :app:assembleDebug
    echo "APK: {{android_apk}}"

# Run the JVM unit tests (no device needed).
android-test:
    @JAVA_HOME="{{java_home}}" {{android_dir}}/gradlew -p {{android_dir}} :app:testDebugUnitTest

# Attach a phone over wifi (Developer options > Wireless debugging shows the port).
android-connect host="192.168.15.7:5555":
    @adb connect {{host}}

# Build and install on the attached phone.
android-install: android-build
    #!/usr/bin/env bash
    set -euo pipefail
    count=$(adb devices | awk 'NR>1 && $2=="device"' | wc -l)
    if [ "$count" -eq 0 ]; then
        echo "No device attached. Connect the phone, then run this again:" >&2
        echo "  USB      enable Settings > Developer options > USB debugging, plug in," >&2
        echo "           and accept the 'Allow USB debugging?' prompt." >&2
        echo "  Wireless enable Wireless debugging, then: just android-connect <ip:port>" >&2
        exit 1
    fi
    if [ "$count" -gt 1 ]; then
        echo "Several devices attached; pick one: adb -s <serial> install -r {{android_apk}}" >&2
        exit 1
    fi
    adb install -r {{android_apk}}

# Install and launch.
android-run: android-install
    @adb shell am start -n {{app_id}}/.MainActivity

# Follow the app's logs.
android-log:
    @adb logcat --pid=$(adb shell pidof {{app_id}})

# Regenerate the launcher icon PNGs from the source SVG.
android-icon:
    @android/tools/icon/render-icon.sh

# Stop the Gradle daemons and drop build output (they hold a few GB).
android-clean:
    @JAVA_HOME="{{java_home}}" {{android_dir}}/gradlew -p {{android_dir}} --stop || true
    @rm -rf {{android_dir}}/app/build {{android_dir}}/build
