// Virus scanning with ClamAV (clamd) over its INSTREAM protocol. Every uploaded file is scanned
// before it is accepted; an infected file is refused and the attempt logged. If the scanner is
// down, the file is accepted, marked "pending" and scanned again by the scheduler; a file found
// infected later is blocked from download and both sides are told.
import net from 'node:net';
import { config } from './config.js';
import { storage } from './storage.js';

export const scanningOn = () => !!config.clamav.host;

/** Scan a readable stream. Resolves { status: 'clean' | 'infected', signature? }; rejects when the scanner cannot be reached. */
export function scanStream(stream) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: config.clamav.host, port: config.clamav.port });
    let answer = '', done = false;
    const fail = (err) => { if (!done) { done = true; sock.destroy(); reject(err); } };
    sock.setTimeout(config.clamav.timeoutMs, () => fail(new Error('virus scanner timed out')));
    sock.on('error', fail);
    sock.on('data', (d) => { answer += d.toString(); });
    sock.on('end', () => {
      if (done) return;
      done = true;
      const a = answer.replace(/\0/g, '').trim();
      const m = /^stream: (.+) FOUND$/.exec(a);
      if (m) resolve({ status: 'infected', signature: m[1] });
      else if (/^stream: OK$/.test(a)) resolve({ status: 'clean' });
      else reject(new Error(`virus scanner answered: ${a || 'nothing'}`));
    });
    sock.on('connect', async () => {
      try {
        sock.write('zINSTREAM\0');
        for await (const chunk of stream) {
          for (let i = 0; i < chunk.length; i += 64 * 1024) {
            const part = chunk.subarray(i, i + 64 * 1024);
            const len = Buffer.alloc(4); len.writeUInt32BE(part.length);
            if (!sock.write(Buffer.concat([len, part]))) await new Promise((r) => sock.once('drain', r));
          }
        }
        sock.end(Buffer.alloc(4)); // zero length: end of stream
      } catch (err) { fail(err); }
    });
  });
}

/** Scan a stored file. Returns { status: 'clean' | 'infected' | 'pending' | 'off', signature? }. Never throws. */
export async function scanStored(key) {
  if (!scanningOn()) return { status: 'off' };
  try {
    return await scanStream(await storage.get(key));
  } catch (err) {
    console.error('antivirus', err.message);
    return { status: 'pending', error: err.message };
  }
}
