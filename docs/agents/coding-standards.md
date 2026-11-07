# Coding standards

Laws for working on this repo, each anchored to a bug it prevents. Reviewers
enforce these; the mechanical parts are additionally gated by automated checks
(`githooks/pre-commit`, CI). Patching discipline lives in `AGENTS.md`; this
file covers the webview/host behavior laws.

## One builder per surface

A control that appears on more than one surface (pane bar, empty-state bar)
is built by exactly ONE shared builder. Two assembly paths for the same bar
drift within a few rounds — the baud dropdown existed on the pane bar and not
the start bar (43723da), and the twin virtualization spacers fought over each
other's nodes. When a UI change touches a control that lives in two places,
find the shared builder first; if none exists, that is the first task.

## Test the live state

Test the connected and connecting states, not just the stopped one — the
port picker's three stacked defects (539ed93 → fc7dcf2) were all invisible in
stopped-state tests: click-triggered refreshes rebuild `<option>` nodes and
slam the native popup shut mid-pick, which happy-dom cannot simulate. When a
control refreshes itself on open, pin element identity across the refresh in
a test; when a behavior depends on session state, write the connected-state
test even if the stopped one already passes.

## Single-event transition tests

Lifecycle transitions (empty→first session, replace, close) are tested in a
FRESH test file — vitest gives each file its own module registry, so a file
that boots alone starts from the pane-shaped empty stub, the state the user
actually starts from. Fire ONE lifecycle event, then assert the intermediate
state immediately. Back-to-back fires cancel intermediate states out: the
stub-resurrection double view (PR #18, 7bd7f80) shipped behind 145 green
tests because the second `sessionCreated` removed the resurrected stub and
the final DOM count looked right. Harness: `test/webviewHarness.ts`.

## A session in the list always has dom

Every consumer (`setFocused`, `refreshFindHighlights`, message routing)
iterates `sessions` and touches `s.dom` without guards. `createSession`
therefore builds the pane and pushes it into the list BEFORE any call that
can remove another session — retiring the stub last keeps the list never
empty-passing and every member always mounted. A crash in `setFocused` while
touching `.dom` is this invariant being violated, not a signal to add `?.`
guards at the consumers.

## Row-height contract

The virtualized renderer needs ONE integer row height shared by CSS and the
JS window math. `rowHeightFor(fontSize)` (src/webview/rowHeight.ts) rounds
once and publishes `--sm-row-h`; the stylesheet consumes it; contract tests
pin all three sides. Never style `.row-line` with em/% or measure per-row at
render time — a 0.5px drift walks the rendered window out of layout deep in
the 10k buffer (6a946c8: scrollbars jumped, find highlights landed outside
the window).

## Counts are machine-synced

The unit-test count in README.md is written by `scripts/check-test-count.mjs`
on every `npm test` run. Do not hand-edit it; if CI fails with a README diff,
run `npm test` locally and stage the count line it syncs.
