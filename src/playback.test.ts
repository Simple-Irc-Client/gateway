import { describe, it, expect } from 'vitest';
import { PlaybackBuffer, SEQ_TAG, addTag, hasTag } from './playback.js';

describe('message tag helpers', () => {
  it('adds a tag to a line without tags', () => {
    expect(addTag(':a PRIVMSG #c :hi', 'k', 'v')).toBe('@k=v :a PRIVMSG #c :hi');
  });

  it('adds a tag in front of existing tags', () => {
    expect(addTag('@msgid=1 :a PRIVMSG #c :hi', 'k', 'v')).toBe('@k=v;msgid=1 :a PRIVMSG #c :hi');
  });

  it('finds tags with and without values', () => {
    expect(hasTag('@time=2026-01-01T00:00:00.000Z;bot :a PRIVMSG #c :hi', 'time')).toBe(true);
    expect(hasTag('@time=x;bot :a PRIVMSG #c :hi', 'bot')).toBe(true);
  });

  it('does not match tag names by prefix or text outside the tags', () => {
    expect(hasTag('@timeout=1 :a PRIVMSG #c :hi', 'time')).toBe(false);
    expect(hasTag(':a PRIVMSG #c :@time=1', 'time')).toBe(false);
  });
});

describe('PlaybackBuffer', () => {
  it('numbers recorded lines from 1', () => {
    const buffer = new PlaybackBuffer(1024);

    expect(buffer.record(':a PRIVMSG #c :one')).toBe(`@${SEQ_TAG}=1 :a PRIVMSG #c :one`);
    expect(buffer.record('@msgid=x :a PRIVMSG #c :two')).toBe(`@${SEQ_TAG}=2;msgid=x :a PRIVMSG #c :two`);
  });

  it('replays only the lines after the given sequence number', () => {
    const buffer = new PlaybackBuffer(1024);
    buffer.record('@time=t1 :a PRIVMSG #c :one');
    buffer.record('@time=t2 :a PRIVMSG #c :two');
    buffer.record('@time=t3 :a PRIVMSG #c :three');

    expect(buffer.since(1)).toEqual({
      lines: [`@${SEQ_TAG}=2;time=t2 :a PRIVMSG #c :two`, `@${SEQ_TAG}=3;time=t3 :a PRIVMSG #c :three`],
      complete: true,
    });
  });

  it('adds the receive time to lines without server-time', () => {
    const buffer = new PlaybackBuffer(1024);
    buffer.record(':a PRIVMSG #c :one', Date.UTC(2026, 0, 2, 3, 4, 5));

    expect(buffer.since(0).lines).toEqual([`@${SEQ_TAG}=1;time=2026-01-02T03:04:05.000Z :a PRIVMSG #c :one`]);
  });

  it('has nothing to replay for a browser that saw every line', () => {
    const buffer = new PlaybackBuffer(1024);
    buffer.record(':a PRIVMSG #c :one');

    expect(buffer.since(1)).toEqual({ lines: [], complete: true });
  });

  it('is complete and empty before any line is recorded', () => {
    expect(new PlaybackBuffer(1024).since(0)).toEqual({ lines: [], complete: true });
  });

  it('drops the oldest lines beyond its byte budget and reports the gap', () => {
    const line = ':a PRIVMSG #c :0123456789';
    const buffer = new PlaybackBuffer(Buffer.byteLength(line) * 2);
    buffer.record(line);
    buffer.record(line);
    buffer.record(line);

    const playback = buffer.since(0);
    expect(playback.lines.map((entry) => entry.split(';')[0])).toEqual([`@${SEQ_TAG}=2`, `@${SEQ_TAG}=3`]);
    expect(playback.complete).toBe(false);
    expect(buffer.since(1).complete).toBe(true);
  });

  it('counts multi-byte characters by their encoded size', () => {
    const line = ':a PRIVMSG #c :żółć';
    const buffer = new PlaybackBuffer(line.length);
    buffer.record(line);

    expect(buffer.since(0)).toEqual({ lines: [], complete: false });
  });

  it('keeps numbering lines that were dropped', () => {
    const buffer = new PlaybackBuffer(0);
    buffer.record(':a PRIVMSG #c :one');

    expect(buffer.record(':a PRIVMSG #c :two')).toBe(`@${SEQ_TAG}=2 :a PRIVMSG #c :two`);
  });
});
