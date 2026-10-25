# Serial Monitor (OSS)

Serial-port monitoring inside VS Code, rebuilt from scratch under MIT — an
open alternative to Microsoft's archived (closed-source) Serial Monitor, with
three features no surveyed serial monitor offers:

- **Tags** — select text, press **+ Tag**, and every matching line is
  Highlighted across the full line. Each tag is a colored chip in the toolbar;
  one click silences it everywhere (highlight *and* filter).
- **Filter** — a global three-state control (off / include / exclude) over tag
  matches. Purely display-layer: nothing is discarded, so switching filters
  back recovers every line still in the buffer.
- **Scroll Lock** — scroll up and the viewport stops while data keeps
  streaming; scroll back to the bottom (or click the indicator) to rejoin.

Plus the complete base monitor: a port picker with friendly names, custom baud
rates, data bits / stop bits / parity, a send input with line-ending choice,
optional per-line receive timestamps, and a capped receive buffer
(10,000 lines by default) behind a virtualized console that stays smooth at
high line rates.

## Getting started (development)

```bash
npm install
npm run build
```

Then press **F5** in VS Code ("Launch Serial Monitor") or launch:

```bash
code --extensionDevelopmentPath=<this repo>
```

Open the monitor from the bottom panel's **SERIAL MONITOR** tab or the
`Serial Monitor: Open Monitor` command.

## Testing without hardware

```bash
npm run smoke:check                       # verify a virtual port pair
npm run smoke:device -- --scenario lines  # feed one end (lines|crlf|split|utf8|burst)
npm test                                  # unit tests (pure seams)
npm run test:integration                  # real VS Code + virtual COM pair
```

Integration tests need a com0com pair (`COM10 ↔ COM11`); see
[docs/smoke-checklist.md](docs/smoke-checklist.md) for the full manual pass.

## Public API

The extension implements the `@microsoft/vscode-serial-monitor-api` contract
(`startMonitoringPort`, `Port`, `onClosed`, version negotiation; TCP reports
unsupported). The vendored surface lives in `src/api/serialMonitorApi.ts` and
resolves this extension after the original one.

## Architecture

- [GLOSSARY.md](GLOSSARY.md) — the domain vocabulary (Tag, Highlight, Filter,
  Scroll Lock, Follow); use these terms in issues and code
- [docs/adr/](docs/adr/) — build-from-scratch, API alignment, unified Tag
  model, display-layer filter + ring buffer
- Spec and tickets live in the GitHub issue tracker (spec: issue #1)
- Test seams: data (chunks → lines → buffer), matching (lines + tags + filter
  mode → visibility/highlight), UI state (scroll events → Follow/locked)

## License

[MIT](LICENSE)
