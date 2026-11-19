// Minimal ZIP writer (stored, no compression: JPG/PNG/WebP are already compressed).
const TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let index = 0; index < bytes.length; index++) crc = TABLE[(crc ^ bytes[index]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

// files: async iterable of { name, blob }. Returns a Blob of the ZIP archive.
export async function buildZip(files, onProgress = () => {}) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  let count = 0;
  const { time, day } = dosTime(new Date());
  for await (const { name, blob } of files) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    if (offset + data.length > 0xFFFFFFFF) throw new Error('This project is larger than 4 GB. Download it in smaller parts.');
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(local, nameBytes, blob);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, day, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
    onProgress(++count);
  }
  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, count, true);
  end.setUint16(10, count, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
