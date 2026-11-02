// Electronic seal of Voixa on the PDFs Pescada issues (tracking reports), as a PAdES signature
// (SubFilter ETSI.CAdES.detached) with a signature timestamp when a TSA is configured (PAdES B-T).
//
// The seal key never has to live on this server: with SEAL_CSC_URL the hash is signed remotely by the
// trust service provider through the Cloud Signature Consortium API (v2), which is how a qualified
// seal (QSealC in a qualified device) is used. SEAL_CERT_FILE / SEAL_KEY_FILE sign locally instead,
// for tests or a non-qualified seal.
import { createHash, createPrivateKey, sign as cryptoSign, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFHexString, PDFString, PDFNumber, PDFArray } from 'pdf-lib';
import { config } from './config.js';
import { tlv, seq, int, oid, parse, requestTimestamp, timestampsOn } from './timestamps.js';

const SHA256 = '2.16.840.1.101.3.4.2.1';
const NULL = Buffer.from([0x05, 0x00]);
const octet = (b) => tlv(0x04, Buffer.from(b));
const derSet = (...items) => tlv(0x31, Buffer.concat([...items].sort(Buffer.compare)));
const attr = (type, value) => seq(oid(type), derSet(value));
const sha256 = (b) => createHash('sha256').update(b).digest();

export const sealMode = () => (config.seal.cscUrl ? 'csc' : config.seal.certFile && config.seal.keyFile ? 'file' : null);
export const sealOn = () => !!sealMode();

/* ---------- signers: give the certificate chain, and sign the signed attributes ---------- */

const pemCerts = (text) => [...String(text).matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)].map((m) => new X509Certificate(m[0]));

function fileSigner() {
  const certs = pemCerts(readFileSync(config.seal.certFile, 'utf8'));
  if (config.seal.chainFile) certs.push(...pemCerts(readFileSync(config.seal.chainFile, 'utf8')));
  const key = createPrivateKey(readFileSync(config.seal.keyFile));
  const ec = key.asymmetricKeyType === 'ec';
  return {
    certs, ec,
    sign: async (data) => cryptoSign('sha256', data, ec ? { key, dsaEncoding: 'der' } : key),
  };
}

let cscToken = null;
async function csc(path, body) {
  const s = config.seal;
  if (!cscToken || cscToken.until < Date.now()) {
    const res = await fetch(s.cscTokenUrl || `${s.cscUrl.replace(/\/$/, '')}/oauth2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: s.cscClientId, client_secret: s.cscClientSecret, scope: 'service' }),
    });
    const t = await res.json().catch(() => ({}));
    if (!res.ok || !t.access_token) throw new Error(`the seal service refused the login (${res.status})`);
    cscToken = { value: t.access_token, until: Date.now() + Math.max(60, (t.expires_in || 600) - 60) * 1000 };
  }
  const res = await fetch(`${s.cscUrl.replace(/\/$/, '')}/csc/v2/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cscToken.value}` }, body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`the seal service answered ${res.status}: ${out.error_description || out.error || ''}`);
  return out;
}

async function cscSigner() {
  const s = config.seal;
  const info = await csc('credentials/info', { credentialID: s.cscCredentialId, certificates: 'chain' });
  const certs = (info.cert?.certificates || []).map((b) => new X509Certificate(Buffer.from(b, 'base64')));
  if (!certs.length) throw new Error('the seal service returned no certificate');
  const ec = certs[0].publicKey.asymmetricKeyType === 'ec';
  return {
    certs, ec,
    sign: async (data) => {
      const hash = sha256(data).toString('base64');
      const auth = await csc('credentials/authorize', { credentialID: s.cscCredentialId, numSignatures: 1, hashes: [hash], hashAlgorithmOID: SHA256, ...(s.cscPin ? { PIN: s.cscPin } : {}) });
      const r = await csc('signatures/signHash', {
        credentialID: s.cscCredentialId, SAD: auth.SAD, hashes: [hash], hashAlgorithmOID: SHA256,
        signAlgo: ec ? '1.2.840.10045.4.3.2' : '1.2.840.113549.1.1.1',
      });
      if (!r.signatures?.[0]) throw new Error('the seal service returned no signature');
      return Buffer.from(r.signatures[0], 'base64');
    },
  };
}

/* ---------- CMS (CAdES baseline) over a digest ---------- */

/** Issuer and serial number of a certificate, as DER, for the SignerIdentifier. */
function issuerAndSerial(certDer) {
  const tbs = parse(certDer).children[0];
  const f = tbs.children[0].tag === 0xa0 ? tbs.children.slice(1) : tbs.children; // skip [0] version
  const serial = certDer.subarray(f[0].start, f[0].end), issuer = certDer.subarray(f[2].start, f[2].end);
  return seq(issuer, serial);
}

export async function cmsFor(contentDigest, signer) {
  const signerDer = Buffer.from(signer.certs[0].raw);
  const attrs = [
    attr('1.2.840.113549.1.9.3', oid('1.2.840.113549.1.7.1')),                 // content type: data
    attr('1.2.840.113549.1.9.4', octet(contentDigest)),                          // message digest
    attr('1.2.840.113549.1.9.16.2.47', seq(seq(seq(octet(sha256(signerDer)))))), // signing certificate v2 (ESS)
  ];
  const signedAttrs = derSet(...attrs);                   // what is signed: the attributes as a SET
  const signature = await signer.sign(signedAttrs);
  let unsigned = Buffer.alloc(0);
  if (timestampsOn()) {
    // signature timestamp (CAdES-T): a TSA token over the signature value
    const t = await requestTimestamp(sha256(signature).toString('hex'));
    unsigned = tlv(0xa1, attr('1.2.840.113549.1.9.16.2.14', t.token).subarray(0));
  }
  const sigAlg = signer.ec ? seq(oid('1.2.840.10045.4.3.2')) : seq(oid('1.2.840.113549.1.1.11'), NULL);
  const signerInfo = seq(
    int(Buffer.from([1])), issuerAndSerial(signerDer), seq(oid(SHA256), NULL),
    tlv(0xa0, signedAttrs.subarray(signedAttrs.length - parse(signedAttrs).body.length)), // [0] IMPLICIT, same content
    sigAlg, octet(signature), unsigned,
  );
  const signedData = seq(
    int(Buffer.from([1])), derSet(seq(oid(SHA256), NULL)), seq(oid('1.2.840.113549.1.7.1')),
    tlv(0xa0, Buffer.concat(signer.certs.map((c) => Buffer.from(c.raw)))),
    derSet(signerInfo),
  );
  return seq(oid('1.2.840.113549.1.7.2'), tlv(0xa0, signedData));
}

/* ---------- PAdES: a signature field in the PDF, then the CMS in its /Contents ---------- */

const RESERVED = 30000; // bytes kept for the CMS (certificate chain and timestamp token included)

/**
 * Seal a PDF built with pdf-lib. Returns the bytes of the sealed PDF.
 * Adobe Acrobat Reader and the EU DSS validator show the seal and whether the document changed.
 */
export async function sealPdf(pdfDoc, { reason = 'Issued by Pescada', location = '' } = {}) {
  const signer = sealMode() === 'csc' ? await cscSigner() : fileSigner();
  const ctx = pdfDoc.context;
  const byteRange = PDFArray.withContext(ctx);
  byteRange.push(PDFNumber.of(0));
  for (let i = 0; i < 3; i++) byteRange.push(PDFName.of('**********'));
  const sigRef = ctx.register(ctx.obj({
    Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'ETSI.CAdES.detached', ByteRange: byteRange,
    Contents: PDFHexString.of('0'.repeat(RESERVED * 2)), Reason: PDFString.of(reason), M: PDFString.fromDate(new Date()),
    Name: PDFString.of(config.seal.name || signer.certs[0].subject.split('\n').find((l) => l.startsWith('O='))?.slice(2) || 'Pescada'),
    ...(location ? { Location: PDFString.of(location) } : {}),
  }));
  const page = pdfDoc.getPages()[0];
  const widgetRef = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: [0, 0, 0, 0], V: sigRef, T: PDFString.of('Pescada seal'), F: 132, P: page.ref,
  }));
  page.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));
  pdfDoc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ SigFlags: 3, Fields: [widgetRef] }));
  const pdf = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));

  const placeholder = Buffer.from(`<${'0'.repeat(RESERVED * 2)}>`);
  const cStart = pdf.indexOf(placeholder), cEnd = cStart + placeholder.length;
  const brText = '/ByteRange [ 0 /********** /********** /********** ]';
  const brAt = pdf.indexOf(brText);
  if (cStart < 0 || brAt < 0) throw new Error('could not prepare the PDF for sealing');
  const range = `/ByteRange [0 ${cStart} ${cEnd} ${pdf.length - cEnd}]`;
  pdf.write(range.padEnd(brText.length, ' '), brAt, 'latin1');
  const digest = sha256(Buffer.concat([pdf.subarray(0, cStart), pdf.subarray(cEnd)]));
  const cms = await cmsFor(digest, signer);
  if (cms.length > RESERVED) throw new Error('the seal is larger than the space kept for it');
  pdf.write(cms.toString('hex').padEnd(RESERVED * 2, '0'), cStart + 1, 'latin1');
  return { pdf, signer: signer.certs[0].subject.replace(/\n/g, ', ') };
}
