export const SEQ_TAG = 'simpleircclient.com/seq';

interface RecordedLine {
  seq: number;
  line: string;
  receivedAt: number;
  bytes: number;
}

export interface Playback {
  lines: string[];
  /** False when lines after the requested one were already dropped to stay within the size limit */
  complete: boolean;
}

/** Whether the line's message tags include `key`. */
export const hasTag = (line: string, key: string): boolean => {
  if (!line.startsWith('@')) {
    return false;
  }
  const tagsEnd = line.indexOf(' ');
  const tags = line.slice(1, tagsEnd === -1 ? undefined : tagsEnd).split(';');
  return tags.some((tag) => tag === key || tag.startsWith(`${key}=`));
};

/** Prepends a message tag; the value must not need IRCv3 escaping. */
export const addTag = (line: string, key: string, value: string): string =>
  line.startsWith('@') ? `@${key}=${value};${line.slice(1)}` : `@${key}=${value} ${line}`;

/**
 * Numbers every line sent to the browser and keeps the most recent ones within a byte budget,
 * so a browser that comes back can receive exactly the lines it has not seen.
 */
export class PlaybackBuffer {
  private readonly maxBytes: number;
  private readonly recorded: RecordedLine[] = [];
  private recordedBytes = 0;
  private lastSeq = 0;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  /** Stores the line and returns it tagged with its sequence number. */
  record(line: string, now = Date.now()): string {
    const seq = ++this.lastSeq;
    const bytes = Buffer.byteLength(line);
    this.recorded.push({ seq, line, receivedAt: now, bytes });
    this.recordedBytes += bytes;

    while (this.recordedBytes > this.maxBytes) {
      const dropped = this.recorded.shift();
      if (!dropped) {
        break;
      }
      this.recordedBytes -= dropped.bytes;
    }

    return addTag(line, SEQ_TAG, String(seq));
  }

  /** Lines recorded after `seq`, tagged for delivery; lines without server-time get the time the gateway received them. */
  since(seq: number): Playback {
    const firstKept = this.recorded[0]?.seq ?? this.lastSeq + 1;
    const lines = this.recorded
      .filter((entry) => entry.seq > seq)
      .map(({ seq: entrySeq, line, receivedAt }) => {
        const timed = hasTag(line, 'time') ? line : addTag(line, 'time', new Date(receivedAt).toISOString());
        return addTag(timed, SEQ_TAG, String(entrySeq));
      });
    return { lines, complete: seq >= firstKept - 1 };
  }
}
