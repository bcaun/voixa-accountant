// Streams multipart uploads straight into storage while hashing them, so the
// SHA-256 recorded in the log is computed by the server from the bytes it stored.
import Busboy from 'busboy';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { config } from './config.js';
import { storage } from './storage.js';
import { HttpError } from './auth.js';

export function parseUpload(req, keyPrefix, { maxFiles = 20 } = {}) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: config.maxUploadMb * 1048576, files: maxFiles, fields: 50 } });
    } catch {
      return reject(new HttpError(400, 'Expected a file upload.'));
    }
    const fields = {};
    const files = [];
    const pending = [];
    let failed = null;
    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (_name, stream, info) => {
      const key = `${keyPrefix}/${randomUUID()}`;
      const hash = createHash('sha256');
      let size = 0;
      const tap = new Transform({ transform(chunk, _e, cb) { hash.update(chunk); size += chunk.length; cb(null, chunk); } });
      const file = { key, name: (info.filename || 'file').slice(0, 255), mime: info.mimeType || 'application/octet-stream' };
      stream.on('limit', () => { failed ??= new HttpError(413, `“${file.name}” is larger than ${config.maxUploadMb} MB.`); });
      const p = storage.put(key, stream.pipe(tap), file.mime)
        .then(() => { Object.assign(file, { size, sha256: hash.digest('hex') }); files.push(file); })
        .catch((err) => { failed ??= err; return storage.remove(key).catch(() => {}); });
      pending.push(p);
    });
    bb.on('error', (err) => { failed ??= err; });
    bb.on('close', async () => {
      await Promise.all(pending);
      if (failed) {
        await Promise.all(files.map((f) => storage.remove(f.key).catch(() => {})));
        return reject(failed);
      }
      resolve({ fields, files });
    });
    req.pipe(bb);
  });
}

export const discard = (files) => Promise.all(files.map((f) => storage.remove(f.key).catch(() => {})));
