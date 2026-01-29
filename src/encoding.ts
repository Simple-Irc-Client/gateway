import iconv from 'iconv-lite';

export function decode(buffer: Buffer, encoding = 'utf8'): string {
  if (encoding === 'utf8' || encoding === 'utf-8') {
    return buffer.toString('utf8');
  }
  try {
    return iconv.decode(buffer, encoding);
  } catch {
    return buffer.toString('utf8');
  }
}

export function encode(text: string, encoding = 'utf8'): Buffer {
  if (encoding === 'utf8' || encoding === 'utf-8') {
    return Buffer.from(text, 'utf8');
  }
  try {
    return iconv.encode(text, encoding);
  } catch {
    return Buffer.from(text, 'utf8');
  }
}
