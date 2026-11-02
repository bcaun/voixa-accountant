// A small ZIP writer (deflate, UTF-8 names), enough for "download these documents".
import { crc32, deflateRawSync } from 'node:zlib';

function dosTime(d) {
  const t = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { t, day };
}

/** entries: [{ name, data: Buffer, date? }] → Buffer of a .zip file */
export function makeZip(entries) {
  const parts = [], central = [];
  let offset = 0;
  const used = new Set();
  for (const e of entries) {
    // folders are kept; anything that could step outside the archive ("..", absolute paths) is dropped
    let name = e.name.split('/').map((s) => s.replace(/[\\:*?"<>|\x00-\x1f]/g, '_')).filter((s) => s && s !== '.' && s !== '..').join('/');
    for (let i = 2; used.has(name.toLowerCase()); i++) name = e.name.replace(/(\.[^.]*)?$/, ` (${i})$1`);
    used.add(name.toLowerCase());
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = e.data;
    const packed = deflateRawSync(raw);
    const useDeflate = packed.length < raw.length;
    const body = useDeflate ? packed : raw;
    const crc = crc32(raw) >>> 0;
    const { t, day } = dosTime(e.date || new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8); local.writeUInt16LE(t, 10); local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(useDeflate ? 8 : 0, 10); c.writeUInt16LE(t, 12); c.writeUInt16LE(day, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
