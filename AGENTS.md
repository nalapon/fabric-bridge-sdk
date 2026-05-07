## Agent skills

### Issue tracker

Issues and PRDs are tracked as local markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default canonical triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context domain-doc layout with root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

## Go codebases

When working with Go code, use Go-native tools to navigate, inspect, format, and validate the codebase. Prefer `gofmt`, `go test`, `go vet`, `go list`, `go doc`, and `gopls` where appropriate instead of treating Go files as plain text only.
