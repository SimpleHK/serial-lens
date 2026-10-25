// Virtual serial device: feeds data into one end of a virtual port pair so
// the extension (connected to the other end) can be smoke-tested with no
// hardware. Requires a port pair such as the com0com COM10 <-> COM11 pair.
//
// Usage:
//   node scripts/virtual-device.mjs [--port COM11] [--baud 115200]
//                                   [--scenario lines|crlf|split|utf8|burst]
//                                   [--interval 100] [--seconds 10]
//
// Scenarios:
//   lines  steady log-like lines, LF-terminated (default)
//   crlf   line endings cycling through LF, CRLF, bare CR
//   split  same lines written in tiny raw chunks (1-3 bytes), including a
//          CRLF split across writes and a UTF-8 char split across writes —
//          stresses the data seam's cross-chunk reassembly
//   utf8   Chinese and emoji lines
//   burst  flood of ~2000 lines/s for --seconds, for eyeballing smoothness
import { SerialPort } from 'serialport';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const portPath = arg('port', 'COM11');
const baudRate = Number(arg('baud', 115200));
const scenario = arg('scenario', 'lines');
const interval = Number(arg('interval', 100));
const seconds = Number(arg('seconds', 10));

const LOG_TEMPLATES = [
  (n) => `[BOOT] firmware v1.2.3 starting (cycle ${n})`,
  (n) => `[SENSOR] temp=${(22 + (n % 9) * 0.7).toFixed(1)}C humidity=${40 + (n % 20)}%`,
  (n) => `[ERROR] checksum mismatch on packet ${1000 + n}`,
  (n) => `[GPS] fix acquired, sats=${4 + (n % 8)}`,
  (n) => `[WARN] rssi low: -${80 + (n % 15)} dBm`,
  (n) => `[INFO] heartbeat ${n}`,
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const port = new SerialPort({ path: portPath, baudRate });
port.on('error', (err) => {
  console.error(`serial error: ${err.message}`);
  process.exit(1);
});

let n = 0;
let running = true;
process.on('SIGINT', () => {
  running = false;
});

port.on('open', () => {
  console.log(`virtual-device: opened ${portPath} @ ${baudRate} — scenario "${scenario}". Ctrl-C to stop.`);
  const scenarios = { lines, crlf, split, utf8, burst };
  const run = scenarios[scenario];
  if (!run) {
    console.error(`unknown scenario "${scenario}" (expected: ${Object.keys(scenarios).join(', ')})`);
    process.exit(1);
  }
  run().catch((err) => {
    console.error(`scenario failed: ${err.message}`);
    process.exit(1);
  });
});

const write = (data) =>
  new Promise((resolve, reject) => port.write(data, (err) => (err ? reject(err) : resolve())));

async function lines() {
  while (running) {
    await write(LOG_TEMPLATES[n % LOG_TEMPLATES.length](n) + '\n');
    n++;
    await sleep(interval);
  }
  port.close();
  console.log('virtual-device: stopped');
}

async function crlf() {
  const endings = ['\n', '\r\n', '\r'];
  while (running) {
    await write(LOG_TEMPLATES[n % LOG_TEMPLATES.length](n) + endings[n % endings.length]);
    n++;
    await sleep(interval);
  }
  port.close();
  console.log('virtual-device: stopped');
}

async function split() {
  const payloads = [
    'OK+CSQ: 24,0\r\n', // CRLF — also torn apart below
    '温度=25°C\n', // multibyte char
    '[DATA] reading 0x1F4A\n',
  ];
  while (running) {
    const payload = payloads[n % payloads.length];
    const bytes = Buffer.from(payload, 'utf-8');
    if (n % payloads.length === 0) {
      // write the CRLF's two halves in separate, delayed writes
      await write(bytes.subarray(0, bytes.length - 2));
      await sleep(20);
      await write('\r');
      await sleep(20);
      await write('\n');
    } else {
      for (let i = 0; i < bytes.length; i += 3) {
        await write(bytes.subarray(i, i + 3));
        await sleep(5);
      }
    }
    n++;
    await sleep(interval);
  }
  port.close();
  console.log('virtual-device: stopped');
}

async function utf8() {
  const lines = [
    '温度传感器 #1：24.7°C ✅',
    '湿度传感器：48% 💧',
    '⚠️ 电压偏低：3.1V',
    '完成标定：🇨🇳 → 🚀',
    '系统就绪：一切正常 ✔',
  ];
  while (running) {
    await write(lines[n % lines.length] + '\n');
    n++;
    await sleep(interval);
  }
  port.close();
  console.log('virtual-device: stopped');
}

async function burst() {
  const deadline = Date.now() + seconds * 1000;
  let sent = 0;
  while (running && Date.now() < deadline) {
    const batch = [];
    for (let i = 0; i < 200; i++) {
      batch.push(LOG_TEMPLATES[n % LOG_TEMPLATES.length](n) + '\n');
      n++;
    }
    await write(batch.join(''));
    sent += 200;
    console.log(`virtual-device: burst ${sent} lines (${Math.round(sent / seconds)}/s target)`);
    await sleep(100);
  }
  port.close();
  console.log(`virtual-device: burst done, ${sent} lines sent`);
}
