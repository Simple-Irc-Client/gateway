import iconv from 'iconv-lite';

const supportedEncodings = new Set([
  'utf8',
  'utf-8',
  'iso-8859-1',
  'iso-8859-2',
  'iso-8859-15',
  'windows-1250',
  'windows-1251',
  'windows-1252',
  'koi8-r',
  'koi8-u',
  'cp437',
  'cp850',
  'latin1',
]);

export function isValidEncoding(encoding: string): boolean {
  return supportedEncodings.has(encoding.toLowerCase()) || iconv.encodingExists(encoding);
}

export function toUtf8(buffer: Buffer, sourceEncoding: string): string {
  if (sourceEncoding.toLowerCase() === 'utf8' || sourceEncoding.toLowerCase() === 'utf-8') {
    return buffer.toString('utf8');
  }

  try {
    return iconv.decode(buffer, sourceEncoding);
  } catch {
    return buffer.toString('utf8');
  }
}

export function fromUtf8(text: string, targetEncoding: string): Buffer {
  if (targetEncoding.toLowerCase() === 'utf8' || targetEncoding.toLowerCase() === 'utf-8') {
    return Buffer.from(text, 'utf8');
  }

  try {
    return iconv.encode(text, targetEncoding);
  } catch {
    return Buffer.from(text, 'utf8');
  }
}
