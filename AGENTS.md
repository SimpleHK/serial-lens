## Agent skills

### Issue tracker

Issues are tracked on GitHub (`SimpleHK/vscode-serial-monitor-oss`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, using default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.

### Coding standards

Behavior laws for webview/host work (one builder per surface, test the live
state, single-event transition tests, the sessions/dom invariant, row-height
contract, machine-synced counts) — each anchored to a bug it prevents. See
`docs/agents/coding-standards.md`.

### Patching discipline for agents

- Programmatic file edits (python/sed) must assert the anchor exists before replacing; a silently no-op patch is a bug.
- Prefer structured file-edit tools over shell heredocs for multi-line changes — bash+python escaping has corrupted `
` literals here repeatedly.
- Never pipe verification commands through `tail`/`grep` without `set -o pipefail`; a masked exit code shipped broken commits twice. Guards: `githooks/pre-commit` (enable once per clone with `git config core.hooksPath githooks`).

### Windows environment notes

- Virtual serial pair: run `scripts/setup-com0com.cmd` elevated, then `npm run smoke:check`. It encodes the com0com quirks (silent install skips driver registration; INFs must land in System32; `setupc` without arguments hangs waiting for stdin).
- Integration tests (`npm run test:integration`) stop the feeder automatically and need COM10/COM11 free — a live monitor session on the pair blocks them with Access denied.
- Webview or manifest misbehaving? Read the logs before guessing: `%APPDATA%/Code/logs/<session>/window*/renderer.log` (workbench warnings: invalid view containers, missing mandatory manifest properties, CSP) and `window*/exthost/exthost.log` (activation errors, unhandled rejections).
