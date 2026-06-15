// Package version holds the CLI version. The value is injected at build time
// via -ldflags "-X .../version.Version=<v>" (see justfile and the release
// workflow); it falls back to "dev" for plain `go build`/`go run`.
package version

var Version = "dev"
