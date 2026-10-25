// S3 storage driver against a real S3-compatible server. Skipped unless TEST_S3_ENDPOINT is set, e.g.
//   moto_server -p 5055 &  TEST_S3_ENDPOINT=http://127.0.0.1:5055 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';

const endpoint = process.env.TEST_S3_ENDPOINT;

test('S3 driver stores, reads back and removes files, including large multipart uploads', { skip: !endpoint && 'TEST_S3_ENDPOINT not set' }, async () => {
  Object.assign(process.env, {
    STORAGE_DRIVER: 's3', S3_ENDPOINT: endpoint, S3_BUCKET: 'voixa-test', S3_REGION: 'auto', S3_FORCE_PATH_STYLE: '1',
    S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test',
  });
  const { S3Client, CreateBucketCommand } = await import('@aws-sdk/client-s3');
  await new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
    .send(new CreateBucketCommand({ Bucket: 'voixa-test' })).catch(() => {});
  const { storage } = await import(`../src/storage.js?s3=${Date.now()}`);
  const read = async (key) => { const chunks = []; for await (const c of await storage.get(key)) chunks.push(c); return Buffer.concat(chunks); };

  const small = Buffer.from('%PDF-1.4 small file');
  await storage.put('companies/test/small', Readable.from([small]), 'application/pdf');
  assert.deepEqual(await read('companies/test/small'), small);

  // 12 MB arrives in chunks of unknown total length, as from an upload form: forces a multipart upload
  const big = randomBytes(12 * 1048576);
  await storage.put('companies/test/big', Readable.from([big.subarray(0, 5e6), big.subarray(5e6)]), 'application/octet-stream');
  assert.ok((await read('companies/test/big')).equals(big));

  await storage.remove('companies/test/small');
  await assert.rejects(storage.get('companies/test/small'));
});
