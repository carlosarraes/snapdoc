# Snapdoc for Android

Read and review your hosted documents from a phone. The list is native; each
document opens in a WebView pointed at the real page, so Mermaid diagrams,
schema tooltips, hosted images, and the comment rail work exactly as they do
in a browser.

## Build and install

```bash
just android-bootstrap   # once: Android SDK packages + local.properties + wrapper
just android-install     # build the debug APK and push it to the attached phone
just android-run         # ...and launch it
```

No cloud build service is involved. `just android-test` runs the JVM unit
tests without a device.

If no phone is attached, `android-install` says so and tells you how to
connect one — over USB, or wirelessly with `just android-connect <ip:port>`.

## First run

Settings asks for a snapdoc API token (`sd_live_…`); the list shows documents
published with that token. Paste it and the app verifies it against
`/v1/whoami` before saving.

Add your passcodes there too. When a protected document is opened, the app
tries the saved ones, remembers which one fits that document, and stays quiet
for 12 hours. If none fit, it asks once and offers to save what works.

Passcode candidates are checked against the token-authenticated content
endpoint, which is free. Only a passcode already known to be correct is spent
on `POST /{id}/unlock`, because failures there are counted per IP across every
artifact and shared with posting comments — brute-forcing it would lock you
out of commenting everywhere for an hour.

## Layout

- `app/src/main/kotlin/dev/carraes/snapdoc/`
  - `net/` — `HttpURLConnection` client and typed errors
  - `artifacts/` — list model, encrypted offline cache, list screen
  - `reader/` — which URL a document opens at, and the WebView
  - `passcode/` — saved passcodes and the unlock flow
  - `security/` — AES-256-GCM blobs under an AndroidKeyStore key
- `tools/icon/` — launcher-icon source and its render script

Everything the app persists (token, passcodes, cached list) is encrypted at
rest. `android:allowBackup="false"` is deliberate: the key cannot leave the
device, so a restored backup would decrypt to nothing.
