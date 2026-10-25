# Manual Smoke Checklist

Webview DOM and real serial I/O stay outside automated tests by decision (see
spec issue #1, Testing Decisions) — this checklist is their verification.
Everything below runs against a **virtual COM pair** (com0com `COM10 ↔ COM11`);
a real device + USB adapter can substitute either end at any time.

Setup:

```bash
npm run build          # or F5 (Launch Serial Monitor) which builds first
npm run smoke:device -- --scenario <scenario>   # feeds COM11; pick per section
```

Open the monitor: bottom panel → SERIAL MONITOR tab (or `Serial Monitor: Open Monitor`).

## Base monitor

- [ ] Port dropdown lists detected ports with friendly descriptions, including `COM10 - com0com - serial port emulator (COM10)`
- [ ] Select COM10 → **▶ Start Monitoring** → status shows Connected, tab title gains the port name
- [ ] `lines` scenario: output appears as lines in real time; **■ Stop Monitoring** stops the stream and frees the port
- [ ] Custom baud: type e.g. `921600` into Baud rate → connects (device side must match)
- [ ] Data bits / Parity / Stop bits changes take effect on reconnect
- [ ] Send input + Enter sends with the selected **Line ending** (`crlf` scenario shows mixed endings round-tripping cleanly)
- [ ] **🗑 Clear** empties the console without dropping the connection

## Tags & highlight

- [ ] Select text in the console (e.g. `[ERROR]`) → **+ Tag** lights up → click it → a colored chip appears and matching lines are colored across the full line
- [ ] Click the chip → dimmed + struck through → highlighting disappears; click again → back
- [ ] Select different text → second tag gets a visibly different palette color
- [ ] ⚙ panel: rename, edit pattern, toggle regex, recolor, delete — all reflected instantly in chips/highlight, and persisted (reload the window: tags survive)

## Filter

- [ ] With ≥2 tags, set **Filter = Include** → only tag-matched lines remain visible; **Exclude** → matched lines hide; **Off** → everything returns (no data was lost)
- [ ] A disabled tag's matches are invisible to the filter too

## Scroll Lock

- [ ] While streaming, scroll up → indicator switches to **🔒 Locked**, viewport holds still, data keeps arriving
- [ ] Scroll back to the bottom → **⇩ Following** resumes; the indicator button also toggles manually and rejoining snaps to the bottom

## Timestamps

- [ ] Enable the **Timestamps** checkbox → new lines get `[HH:MM:SS.mmm]` prefixes; toggle off → decoration disappears from new lines
- [ ] Tag matching is unaffected by timestamps either way (match on the same text with timestamps on and off)

## Buffer & performance

- [ ] `burst --seconds 10` (~2000 lines/s): console stays smooth and responsive (virtualized rendering)
- [ ] After a long burst, memory stays bounded and the oldest lines are gone (buffer capped at `serialMonitor.maxBufferLines`, default 10,000)
- [ ] Lower `serialMonitor.maxBufferLines` to e.g. 500 mid-session → buffer trims immediately

## Public API (consumer view)

- [ ] Another extension (or the integration suite) can call `getSerialMonitorApi(Version.latest)` → `listAvailablePorts` → `startMonitoringPort` → `Port.onClosed` fires on stop

## Known MVP limits (by design, see spec Out of Scope)

- One monitor at a time; TCP/SWO unsupported (API reports it); no inline badges, ANSI interpretation, plotting, or send macros. Log export exists (📤).
