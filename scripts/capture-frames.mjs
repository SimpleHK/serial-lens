#!/usr/bin/env node
// Capture high-resolution PNG frames of the REAL webview (served by
// scripts/webview-preview.mjs) for the README GIFs, by driving headless
// Chrome over the DevTools protocol. Each frame runs one choreography step
// in the page, then a screenshot is taken. After capturing, assemble with:
//
//   node scripts/make-gif.mjs .frames/<scene> docs/media/demo-<scene>.gif <delayMs> 1
//
//   node scripts/capture-frames.mjs [outDir] [delayMsBetweenFramesNotUsed]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const OUT_ROOT = resolve(process.argv[2] ?? '.frames');
const FRAMES = 30;
const VIEWPORT = { width: 1200, height: 740 };
const PREVIEW_PORT = 8231;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// ---------------------------------------------------------------- scenes
// Each step is page JavaScript executed (awaited) per frame. `H` is the
// preview's __host; helpers come from BOOT.
const errTag = "({ id: 't1', name: 'ERROR', pattern: '[ERROR]', isRegex: false, color: '#f14c4c', highlight: true, filter: true })";
const portTag = "({ id: 't2', name: 'sensor', pattern: 'sensor', isRegex: false, color: '#3794ff', highlight: true, filter: false })";
const S = "{ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' }";

const BOOT = `
  window.H = (m) => __host(m);
  window.clickEl = (sel) => { const el = document.querySelector(sel); if (!el) throw new Error('no ' + sel); el.click(); };
  window.clickMenuItem = (label) => {
    const el = [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes(label));
    if (!el) throw new Error('no menu item ' + label);
    el.click();
  };
`;

const noise = (i) => `sensor poll ${i} ok`;
const hits = ['[ERROR] checksum mismatch on sensor 2', '[ERROR] sensor 4 timeout', 'sensor 7 resync [ERROR] dropped'];

const wrap = (body) => `(async () => { ${body} })()`;
const append = (id, lines) => `H({ type: 'append', sessionId: ${id}, dropCount: 0, lines: ${JSON.stringify(lines)} });`;

const scenes = {
  // A tag lands mid-stream; matches light up; then include-filter narrows.
  tags(n) {
    const steps = [
      `H({ type: 'ports', ports: [{ path: 'COM10', description: 'USB Serial' }] });`,
      `H({ type: 'sessionCreated', sessionId: 1, kind: 'port', title: 'COM10', state: 'connecting', settings: ${S} });`,
      `H({ type: 'state', sessionId: 1, state: 'connected' });`,
    ];
    const tagFrame = Math.floor(n / 2) - 3;
    let k = 0;
    for (let f = steps.length; f < n - 4; f++) {
      const lines = [noise(k++)];
      if (f > tagFrame && f % 2 === 0) lines.push(hits[k % hits.length]);
      steps.push(append(1, lines));
      if (f === tagFrame) {
        // The tag lands mid-stream as its own step: the following appends
        // light up (a tags message inside `lines` would be logged as text).
        steps.push(`H({ type: 'tags', sessionId: 1, tags: [${errTag}, ${portTag}] });`);
      }
    }
    steps.push(wrap(`clickEl('.filter-toggle');`));
    steps.push(wrap(`clickMenuItem('Include');`));
    steps.push(append(1, ['[ERROR] still streaming', noise(99)]));
    steps.push(wrap(`clickEl('.filter-toggle');`));
    return steps;
  },

  // The find widget: open, query, counter, next/prev jumps.
  find(n) {
    const steps = [
      `H({ type: 'ports', ports: [{ path: 'COM10' }] });`,
      `H({ type: 'sessionCreated', sessionId: 1, kind: 'port', title: 'COM10', state: 'connecting', settings: ${S} });`,
      `H({ type: 'state', sessionId: 1, state: 'connected' });`,
    ];
    let k = 0;
    for (let f = steps.length; f < n - 6; f++) {
      const lines = [noise(k++)];
      if (f % 3 === 0) lines.push(`[ERROR] frame ${k} CRC failed`);
      steps.push(append(1, lines));
    }
    steps.push(wrap(`clickEl('button[title^="Find in"]');`));
    steps.push(wrap(
      `const i = document.querySelector('.find-bar input'); i.value = 'error'; i.dispatchEvent(new Event('input', { bubbles: true }));`,
    ));
    steps.push(wrap(`await new Promise(r => setTimeout(r, 250));`)); // find debounces 150ms
    steps.push(wrap(`clickEl('.find-nav .fbtn[title^="Next"]');`));
    steps.push(wrap(`clickEl('.find-nav .fbtn[title^="Next"]');`));
    steps.push(wrap(`clickEl('.find-nav .fbtn[title^="Previous"]');`));
    steps.push(wrap(`clickEl('.find-bar .fbtn[title^="Close"]');`));
    return steps;
  },

  // Two ports streaming side by side.
  split(n) {
    const steps = [
      `H({ type: 'ports', ports: [{ path: 'COM10', description: 'USB Serial' }, { path: 'COM12', description: 'USB Serial' }] });`,
      `H({ type: 'sessionCreated', sessionId: 1, kind: 'port', title: 'COM10', state: 'connecting', settings: ${S} });`,
      `H({ type: 'sessionCreated', sessionId: 2, kind: 'port', title: 'COM12', state: 'connecting', settings: ${S} });`,
      `H({ type: 'state', sessionId: 1, state: 'connected' });`,
      `H({ type: 'state', sessionId: 2, state: 'connected' });`,
    ];
    let k = 0;
    for (let f = steps.length; f < n; f++) {
      steps.push(
        append(1, ['left: packet ' + k, k % 4 === 0 ? '[ERROR] left retry' : noise(k)]) +
        append(2, ['right: packet ' + k, k % 5 === 0 ? '[ERROR] right retry' : noise(k + 500)]),
      );
      k++;
    }
    return steps;
  },

  // Funnel filter round trip: include narrows, exclude hides.
  filter(n) {
    const steps = [
      `H({ type: 'ports', ports: [{ path: 'COM10' }] });`,
      `H({ type: 'sessionCreated', sessionId: 1, kind: 'port', title: 'COM10', state: 'connecting', settings: ${S} });`,
      `H({ type: 'state', sessionId: 1, state: 'connected' });`,
      `H({ type: 'tags', sessionId: 1, tags: [${errTag}] });`,
    ];
    let k = 0;
    for (let f = steps.length; f < n - 4; f++) {
      const lines = [noise(k++)];
      if (f % 2 === 0) lines.push(hits[k % hits.length]);
      steps.push(append(1, lines));
    }
    steps.push(wrap(`clickEl('.filter-toggle');`));
    steps.push(wrap(`clickMenuItem('Include');`));
    steps.push(append(1, ['[ERROR] only this shows', noise(98)]));
    steps.push(wrap(`clickEl('.filter-toggle');`));
    steps.push(wrap(`clickMenuItem('Exclude');`));
    steps.push(append(1, ['[ERROR] hidden now', noise(99)]));
    return steps;
  },
};

// ------------------------------------------------------------------- CDP
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else res(msg.result);
      }
    });
  }
  static connect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.once('open', () => res(new Cdp(ws)));
      ws.once('error', rej);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'page error');
    }
    return r.result?.value;
  }
  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  close() {
    try { this.ws.close(); } catch { /* already gone */ }
  }
}

const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${e.message}`);
      await sleep(200);
    }
  }
};

async function main() {
  const repo = resolve(import.meta.dirname, '..');
  const preview = spawn(process.execPath, ['scripts/webview-preview.mjs', String(PREVIEW_PORT)], {
    cwd: repo,
    stdio: 'pipe',
  });
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${join(OUT_ROOT, '.profile')}`,
    '--no-first-run',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let cdp;
  try {
    await until(async () => {
      const r = await fetch(`http://127.0.0.1:${PREVIEW_PORT}/`);
      if (!r.ok) throw new Error('preview not ok');
    }, 20000, 'preview server');

    const { wsUrl, httpPort } = await until(async () => {
      const buf = chrome.stderr.read();
      const text = buf ? buf.toString() : '';
      const ws = text.match(/ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/[^\s]+/);
      if (!ws) throw new Error('devtools endpoint not announced yet');
      return { wsUrl: ws[0], httpPort: ws[1] };
    }, 20000, 'chrome devtools endpoint');

    // Attach to the page target through the browser endpoint (flatten mode:
    // every following call passes the sessionId at the message top level).
    cdp = await Cdp.connect(wsUrl);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const sendTo = (method, params = {}) => cdp.send(method, params, sessionId);
    const evalPage = (expression, awaitPromise = false) =>
      cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId)
        .then((r) => {
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'page error');
          return r.result?.value;
        });

    await sendTo('Page.enable');
    await sendTo('Runtime.enable');
    await sendTo('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
    });
    await sendTo('Page.navigate', { url: `http://127.0.0.1:${PREVIEW_PORT}/` });
    await until(async () => {
      return (await evalPage('document.readyState === "complete" && typeof __host === "function"')) === true;
    }, 20000, 'page ready');

    await sendTo('Runtime.evaluate', { expression: BOOT });

    for (const [name, build] of Object.entries(scenes)) {
      const dir = join(OUT_ROOT, name);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const steps = build(FRAMES);
      // Reset between scenes: a fresh reload gives every scene the empty page.
      await sendTo('Page.navigate', { url: `http://127.0.0.1:${PREVIEW_PORT}/` });
      await until(async () => {
        return (await evalPage('typeof __host === "function" && document.querySelectorAll(".pane").length > 0')) === true;
      }, 20000, `${name} page reset`);
      await sendTo('Runtime.evaluate', { expression: BOOT });

      for (let f = 0; f < steps.length; f++) {
        await evalPage(steps[f], true);
        await sleep(30); // let the rAF render land
        const shot = await sendTo('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(dir, `f${String(f).padStart(3, '0')}.png`), Buffer.from(shot.data, 'base64'));
      }
      console.log(`${name}: ${steps.length} frames -> ${dir}`);
    }
  } finally {
    cdp?.close();
    chrome.kill();
    preview.kill();
    if (existsSync(join(OUT_ROOT, '.profile'))) {
      try { rmSync(join(OUT_ROOT, '.profile'), { recursive: true, force: true, maxRetries: 3 }); } catch { /* locked, ignore */ }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
