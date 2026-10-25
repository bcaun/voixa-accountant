// File storage. "fs" keeps files on local disk (development, single server);
// "s3" works with AWS S3, Cloudflare R2, Google Cloud Storage (S3 API) or MinIO.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';

function fsDriver(root) {
  const full = (key) => {
    const p = path.resolve(root, key);
    if (!p.startsWith(path.resolve(root) + path.sep)) throw new Error('bad storage key');
    return p;
  };
  return {
    async put(key, stream) {
      await mkdir(path.dirname(full(key)), { recursive: true });
      await pipeline(stream, createWriteStream(full(key), { flags: 'wx' }));
    },
    async get(key) {
      await stat(full(key));
      return createReadStream(full(key));
    },
    async remove(key) {
      await rm(full(key), { force: true });
    },
  };
}

async function s3Driver(cfg) {
  const { S3Client, GetObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const { Upload } = await import('@aws-sdk/lib-storage');
  const s3 = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: cfg.accessKeyId ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } : undefined,
    // send and check checksums only where the S3 API requires them; R2 and some other
    // S3-compatible stores reject the extra checksum headers newer SDKs add by default
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    async put(key, stream, contentType) {
      await new Upload({ client: s3, params: { Bucket: cfg.bucket, Key: key, Body: stream, ContentType: contentType } }).done();
    },
    async get(key) {
      const out = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      return out.Body;
    },
    async remove(key) {
      // With Object Lock enabled this only adds a delete marker; locked versions stay.
      await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },
  };
}

export const storage = config.storage.driver === 's3'
  ? await s3Driver(config.storage)
  : fsDriver(config.storage.dir);
