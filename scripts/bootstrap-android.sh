#!/usr/bin/env bash
# Installs everything needed to build android/ locally: the Android SDK
# packages, android/local.properties, and the Gradle wrapper. Idempotent —
# re-running it is cheap and skips whatever is already present.
set -euo pipefail

tools_version=15859902
tools_sha=4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583
gradle_version=9.4.1
sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/android-sdk}}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdkmanager="$sdk_root/cmdline-tools/latest/bin/sdkmanager"

# The SDK tools are JVM programs, and on this machine `java` is an asdf shim
# that resolves to nothing unless a version is pinned. Find a real JDK.
if [[ -z "${JAVA_HOME:-}" ]]; then
  for candidate in "$HOME"/.asdf/installs/java/temurin-17* "$HOME"/.asdf/installs/java/temurin-21* /usr/lib/jvm/java-17-* /usr/lib/jvm/default; do
    if [[ -x "$candidate/bin/java" ]]; then
      JAVA_HOME="$candidate"
      break
    fi
  done
fi
if [[ -z "${JAVA_HOME:-}" || ! -x "${JAVA_HOME}/bin/java" ]]; then
  echo "error: no JDK found. Install one (JDK 17+) or set JAVA_HOME." >&2
  exit 1
fi
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

if [[ ! -x "$sdkmanager" ]]; then
  work_dir="$(mktemp -d)"
  trap 'rm -rf "$work_dir"' EXIT
  archive="$work_dir/command-line-tools.zip"
  curl --fail --location --show-error \
    "https://dl.google.com/android/repository/commandlinetools-linux-${tools_version}_latest.zip" \
    --output "$archive"
  printf '%s  %s\n' "$tools_sha" "$archive" | sha256sum --check --status
  unzip -q "$archive" -d "$work_dir/unpacked"
  mkdir -p "$sdk_root/cmdline-tools"
  rm -rf "$sdk_root/cmdline-tools/latest"
  mv "$work_dir/unpacked/cmdline-tools" "$sdk_root/cmdline-tools/latest"
fi

yes | "$sdkmanager" --sdk_root="$sdk_root" --licenses >/dev/null || true
"$sdkmanager" --sdk_root="$sdk_root" \
  "platforms;android-36" \
  "build-tools;36.0.0" \
  "platform-tools"

escaped_sdk="${sdk_root//\\/\\\\}"
escaped_sdk="${escaped_sdk// /\\ }"
printf 'sdk.dir=%s\n' "$escaped_sdk" > "$repo_root/android/local.properties"

if [[ ! -f "$repo_root/android/gradle/wrapper/gradle-wrapper.jar" ]]; then
  work_dir="${work_dir:-$(mktemp -d)}"
  trap 'rm -rf "$work_dir"' EXIT
  gradle_archive="$work_dir/gradle-${gradle_version}-bin.zip"
  curl --fail --location --show-error \
    "https://services.gradle.org/distributions/gradle-${gradle_version}-bin.zip" \
    --output "$gradle_archive"
  unzip -q "$gradle_archive" -d "$work_dir/gradle"
  "$work_dir/gradle/gradle-${gradle_version}/bin/gradle" \
    --no-daemon --project-dir "$repo_root/android" wrapper --gradle-version "$gradle_version"
fi

printf 'Android SDK ready at %s\nJAVA_HOME=%s\n' "$sdk_root" "$JAVA_HOME"
