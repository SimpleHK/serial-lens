// Cross-talk check for a virtual (or real) serial port pair.
// Opens both ends, writes A->B and B->A, and verifies both messages arrive.
// Usage: node scripts/vserial-check.mjs [portA] [portB]
//   defaults: COM10 COM11 (the com0com pair created for smoke tests)
import { SerialPort } from 'serialport';

const [portPathA = 'COM10', portPathB = 'COM11'] = process.argv.slice(2);

const open = (path) =>
  new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate: 115200 });
    port.once('error', (err) => reject(new Error(`${path}: ${err.message}`)));
    port.once('open', () => resolve(port));
  });

const collect = (port, marker) =>
  new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf-8');
      if (buf.includes(marker)) {
        port.off('data', onData);
        resolve(buf);
      }
    };
    port.on('data', onData);
    setTimeout(() => reject(new Error(`timeout waiting for "${marker}"`)), 5000);
  });

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  console.error('Is the com0com pair installed? (expect two linked ports, e.g. COM10 <-> COM11)');
  process.exit(1);
};

let a, b;
try {
  [a, b] = await Promise.all([open(portPathA), open(portPathB)]);
} catch (err) {
  fail(err.message);
}

const toB = collect(b, 'ping-from-A');
const toA = collect(a, 'pong-from-B');
a.write('ping-from-A\n');
b.write('pong-from-B\n');

try {
  await Promise.all([toB, toA]);
  console.log(`PASS: ${portPathA} <-> ${portPathB} both directions ok`);
  process.exit(0);
} catch (err) {
  fail(err.message);
} finally {
  a.close();
  b.close();
}
