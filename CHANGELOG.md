# Changelog

All notable changes to Serial Monitor (OSS) are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [0.6.1] - 2026-11-08

### Fixed

- **■ then ▶ kept the pane's log** — a restart (■/▶, a port move, a
  parameter change) used to swap in a fresh session and wipe the buffered
  lines; the log belongs to the pane and now travels across the swap
  (arrays move by reference, so lines arriving mid-restart are kept too).
- **■ did nothing during a live param-edit reconnect** — the reconnect
  pipeline's teardown made a concurrent disconnect a no-op and then
  reopened the port anyway; a stop now cancels the pending reconnect.

### Changed

- **Smooth follow** — the viewport eases toward the bottom (per-frame
  exponential catch-up) instead of teleporting on every append; a user
  scroll still locks instantly, and a restart lands at the bottom in one
  step.
- **Restart polish** — no blank-frame flicker on reveal (the restored log
  paints synchronously), the tag bar comes back with the pane, and the
  restart always rejoins the live tail.
- **Refresh rate** — the serial-to-pixel merge window halved (16 ms →
  8 ms) and burst flushes wired in (maxItems 64), so a fast stream reaches
  the pixels sooner.
- **Invalid regex tags are flagged live** in the manage panel (red border
  + hint) instead of silently never matching; the ⚙ panel shows the
  running version; per-append control refresh and overview-strip repaint
  costs cut; an automated headed-Chrome performance probe joined
  `scripts/`.
- README GIFs re-recorded at full resolution (and smaller).

## [0.6.0] - 2026-11-07

### Changed

- **Renamed to Serial Lens.** The product outgrew the "rebuild" framing —
  tag highlighting, display-layer filtering, and editor-style find are its
  own features, not parity items. Extension id is now `simplehk.serial-lens`
  (the marketplace publish has not happened yet, so nothing breaks), the
  GitHub repository moved to `SimpleHK/serial-lens` (old URLs redirect), and
  the independence/trademark disclaimer shrank accordingly. The vendored
  public API still negotiates with the upstream surface it was vendored
  from.

## [0.5.0] - 2026-11-07

### Added

- **The ⚙ manage panel shows the extension version** (host-injected from the
  manifest) — field reports have twice been stale-VSIX artifacts; now the
  running VSIX is unmistakable.

### Fixed

- **Starting the first session from the empty bar opened two views.** The
  empty state is a pane-shaped stub session (0.4.0); a real session arriving
  retired it — but `removeSession` saw a momentarily empty list and ran its
  "empty surface returns" hook, resurrecting the stub beside the new pane.
  The new session is now built and joins the list before the stub retires.
  A lone pane taking over the empty slot also no longer carries a stray
  divider. Regression tests drive the ▶-from-empty path end to end,
  including close → empty returns → start again.

### Changed

- **Tech-debt round.** The 14-branch host-message listener in main.ts is now
  `webview/hostRouter.ts` — an explicit-context handler map whose routing
  decisions (including the restart flow's pendingReplace two-phase
  transitions) are covered by 14 node-speed tests; the type domain moved to
  `webview/paneTypes.ts` (main.ts: 2329 → 2132 lines). Invalid regex tags
  are flagged live in the manage panel (red border + `aria-invalid` + hint)
  instead of silently never matching. A leftover debug `console.log` in the
  webview test suite is gone.
- **All four README GIFs re-recorded at full resolution** (1200×740, crisp
  text) — and smaller, 1.8 MB total vs 6.2 MB. The capture pipeline is
  committed (`scripts/capture-frames.mjs`: headless Chrome over CDP driving
  the real webview preview), so re-recording is one command.
- Test-count guardrails: the README count is machine-synced by `npm test`,
  and the integration launcher pre-flights the COM pair and falls back from
  a stale VS Code update mutex (PR #19).

## [0.4.0] - 2026-11-06

### Changed

- **The empty state is a pane-shaped Session** — one bar builder, one
  refresh path for both states; the parallel assembly, the second port-pick
  policy, and four module-level state variables are deleted (net −69 lines).
- **Tag list changes flow through a single gateway** (`setTags`/`applyTagEdit`); the funnel
  icon joined the SVG icon set (no inline SVG or emoji left in the toolbar).
- Find widget redesigned to the VS Code anatomy: segmented toggle group
  glued to the input, no-results feedback on the input border, nav group.
- Controls enlarged for click comfort (icons 32×28, actions 28×28);
  Start/Stop and Clear are 48×28 primaries, Clear sits beside Start/Stop.
- Per-pane tags and per-pane filter mode (ADR-0006) — a tag created from a
  pane belongs to that pane alone; each port's set persists separately.

### Fixed

- Port pickers survive their own refresh round-trip; picking another port
  while connected moves the pane; a failed open re-enables the picker and
  routes the reason to the content area.
- Closing a pane mid-restart no longer strands an invisible pane holding a
  serial port; rapid ▶ cannot stack sessions; Ctrl+F no longer opens the
  workbench find.

## [0.3.0] - 2026-11-03

### Added

- **The start bar carries the full serial config** — the same baud
  quick-pick (▾ recents + presets) and collapsible params (☰ data bits /
  parity / stop bits / line ending) that pane bars have, built from one
  shared builder so the two surfaces cannot drift. Chosen values, including
  line ending, flow into the connect.

### Changed

- **Send with line ending `None`** no longer falls back to `LF` (UI form
  `None` vs host form `none` is now normalized case-insensitively).
- **Port picker is a live edit** — it stays usable while connected and
  picking another port moves the pane through the replace flow (only the
  connecting state locks it, visibly); the picker's own refresh no longer
  resets a pick that is still in the list.
- **Tags and filter mode are per pane (ADR-0006)** — a tag created from a
  pane belongs to that pane: its chips, highlighting, find, and include/
  exclude filter apply there alone. Each port's tag set persists separately
  (`serialMonitor.portTags`, keyed from session creation so stopped-pane
  edits are not lost) and survives close/reopen; the global
  `serialMonitor.tags` setting is no longer used.

### Fixed

- Port pickers survive their own refresh round-trip: an unchanged list is
  not rebuilt mid-pick (the popup stays open), and the start bar keeps a
  pick that still exists in the refreshed list.

## [0.2.0] - 2026-11-02

### Added

- **Split-view multi-monitor** — one session per pane: several ports stream
  side by side, each with an independent buffer, Follow/Lock state,
  log-to-file, and send bar. Draggable divider between panes (ADR-0005).
- **Per-pane serial config** embedded in each pane bar (port, baud, data
  bits, parity, stop bits, line ending). Port locked while connected; baud /
  data bits / parity / stop bits edits **live-reconnect** the session in
  place, keeping the pane, its buffer, and its log file.
- **Open log files** — saved `.log`/`.txt` files open as read-only panes with
  the full find / filter / export tooling (new `Serial Monitor: Open Log
  File...` command and 📂 button).
- **Find per pane** (Ctrl+F, F3 / Shift+F3) — match-case, whole word, and
  regex modes with an occurrence counter, prev/next navigation, text-level
  highlighting through the CSS Custom Highlight API, and a find-tick overview
  strip.
- **Doubled global controls** — every pane bar carries its own copy of the
  global actions (add monitor, refresh, filter, timestamps, log directory,
  open file, tags, manage) and a per-pane status readout; nothing re-parents
  on focus. Filter control is a funnel (inline SVG).
- **Iconized toolbar** — filter funnel, broom→trash clear, ⏱ timestamps
  toggle, ⚪/🔴 log-to-file, ▾ baud quick-pick per pane (recents first).
- Connection hints: empty-pane state hints (Connecting… / Waiting for data… /
  Stopped), iconized per-pane status (✔ / ⌛ / ○) with transient messages.
- Public API: several `startMonitoringPort` sessions may run at once; the
  `lineEnding` push is session-tagged.

### Changed

- Console text uses the Microsoft-terminal gray palette (#cccccc dark /
  #3b3b3b light) for both themes.
- Receive timestamps default to **on**.
- The clear action is the trash-can icon; the tag-filter is a funnel.
- Wire protocol and find/window-math/status cores are shared, typed modules
  (`shared/protocol.ts`, `webview/findCore.ts`, `webview/windowMath.ts`,
  `shared/lineText.ts`).

### Fixed

- Scroll position drift that made both panes' scrollbars jump and broke find
  jumps (integer row-height contract between CSS and the renderer).
- Silent wiring drops from the pane refactor (tag button, spacers shared
  across panes).
- A failed pane restart can no longer strand the replace request; the old
  pane survives.
- Empty-state row pinned to the top; no phantom horizontal scrollbar.

## [0.1.0] - 2026-10-31

### Added

- Initial MVP: base monitor (port picker, serial params, send bar, capped
  ring buffer, virtualized console), per-tag highlight/filter with the
  three-state global filter, Scroll Lock, per-session log directory and
  one-shot export, per-line receive timestamps, vendored public API
  (`startMonitoringPort`, `Port.onClosed`, version negotiation), com0com
  smoke tooling, and the integration suite.
