import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import * as tls from 'node:tls';
import iconv from 'iconv-lite';

const CONNECT_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 30_000;

// A server that never sends a line terminator must not grow memory without bound
const MAX_RECEIVE_BUFFER_SIZE = 2 * 1024 * 1024;

const LF = 0x0a;
const CR = 0x0d;

/** Removes CR and LF, so one value can never become two IRC lines (line injection). */
export const stripCRLF = (input: string): string => input.replace(/[\r\n]/g, '');

/** The command word of an IRC line, after any tags and source. */
export const ircCommand = (line: string): string | undefined => {
  const words = line.split(' ');
  let index = 0;
  if (words[index]?.startsWith('@')) {
    index++;
  }
  if (words[index]?.startsWith(':')) {
    index++;
  }
  return words[index]?.toUpperCase();
};

/** WEBIRC tells the IRC server the browser's address instead of the gateway's. */
export interface WebircConfig {
  password: string;
  gateway: string;
  hostname: string;
  ip: string;
}

export interface IrcClientOptions {
  host: string;
  port: number;
  tls: boolean;
  encoding: string;
  /** Requires `tls`, since it carries a password */
  webirc?: WebircConfig;
  /** Seconds the server may stay silent after our PING */
  pongTimeout: number;
  /** Replaces DNS resolution, e.g. to refuse private addresses */
  lookup?: net.LookupFunction;
}

export interface SocketMeta {
  localPort: number;
  localAddress: string;
  remotePort: number;
  remoteAddress: string;
}

interface IrcClientEvents {
  'socket connected': [meta: SocketMeta];
  line: [line: string];
  close: [];
  error: [error: Error];
}

/**
 * Connection to an IRC server on behalf of one browser, which does its own registration.
 * The gateway only sends WEBIRC first, answers server PINGs, and PINGs the server to detect a dead connection.
 */
export class IrcClient extends EventEmitter<IrcClientEvents> {
  private socket: net.Socket | null = null;
  private receiveBuffer = Buffer.alloc(0);
  private encoding = 'utf8';
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  connect(options: IrcClientOptions): void {
    this.destroy();

    this.encoding = options.encoding;
    this.receiveBuffer = Buffer.alloc(0);

    const target = { host: options.host, port: options.port, lookup: options.lookup };
    const socket = options.tls ? tls.connect({ ...target, rejectUnauthorized: true }) : net.connect(target);
    this.socket = socket;

    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('timeout', () => socket.destroy(new Error('Connection timed out')));
    // On TLS, 'connect' fires before the handshake, so a stalled handshake would never time out
    socket.once(options.tls ? 'secureConnect' : 'connect', () => this.handleConnected(options));

    socket.on('data', (data: Buffer) => this.handleData(data));
    socket.on('close', () => {
      this.stopKeepalive();
      this.emit('close');
    });
    socket.on('error', (error: Error) => this.emit('error', error));
  }

  /** `false` means the socket is not writable or its buffer is full; wait for `waitForDrain()`. */
  send(line: string): boolean {
    if (!this.socket?.writable) {
      return false;
    }
    return this.socket.write(this.encode(`${stripCRLF(line)}\r\n`));
  }

  get writable(): boolean {
    return this.socket?.writable ?? false;
  }

  /** Rejects if the socket closes before draining. */
  waitForDrain(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket) {
        reject(new Error('Socket closed'));
        return;
      }
      if (!socket.writableNeedDrain) {
        resolve();
        return;
      }
      const onDrain = (): void => {
        socket.off('close', onClose);
        resolve();
      };
      const onClose = (): void => {
        socket.off('drain', onDrain);
        reject(new Error('Socket closed before drain'));
      };
      socket.once('drain', onDrain);
      socket.once('close', onClose);
    });
  }

  // Lets TCP flow control slow the server down while the WebSocket client catches up
  pause(): void {
    this.socket?.pause();
  }

  resume(): void {
    this.socket?.resume();
  }

  quit(message: string): void {
    if (this.socket?.writable) {
      this.send(`QUIT :${message}`);
      this.socket.end();
    }
    this.stopKeepalive();
  }

  destroy(): void {
    this.stopKeepalive();
    this.socket?.destroy();
    this.socket = null;
  }

  private handleConnected(options: IrcClientOptions): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    socket.setTimeout(0);

    this.emit('socket connected', {
      localPort: socket.localPort ?? 0,
      localAddress: socket.localAddress ?? '',
      remotePort: socket.remotePort ?? 0,
      remoteAddress: socket.remoteAddress ?? '',
    });

    // WEBIRC must be the first line the server sees
    if (options.webirc) {
      const { password, gateway, hostname, ip } = options.webirc;
      this.send(`WEBIRC ${password} ${gateway} ${hostname} ${ip}`);
    }

    this.startKeepalive(options.pongTimeout * 1000);
  }

  private handleData(data: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

    // RFC 1459 mandates CRLF, but some servers and bouncers send a bare LF
    let lineEnd: number;
    while ((lineEnd = this.receiveBuffer.indexOf(LF)) !== -1) {
      const contentEnd = lineEnd > 0 && this.receiveBuffer[lineEnd - 1] === CR ? lineEnd - 1 : lineEnd;
      const line = this.decode(this.receiveBuffer.subarray(0, contentEnd));
      this.receiveBuffer = this.receiveBuffer.subarray(lineEnd + 1);

      if (line.length > 0) {
        this.handleLine(line);
      }
    }

    if (this.receiveBuffer.length > MAX_RECEIVE_BUFFER_SIZE) {
      this.socket?.destroy(new Error('Receive buffer overflow'));
    }
  }

  private handleLine(line: string): void {
    // Any line proves the server is alive
    this.clearPongTimer();
    this.emit('line', line);

    if (line.startsWith('PING ')) {
      this.send(`PONG ${line.slice('PING '.length)}`);
    }
  }

  private startKeepalive(pongTimeoutMs: number): void {
    this.pingTimer = setInterval(() => {
      this.send(`PING :${Date.now()}`);
      this.clearPongTimer();
      this.pongTimer = setTimeout(() => {
        this.socket?.destroy(new Error('PONG timeout: server unresponsive'));
      }, pongTimeoutMs);
    }, PING_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private decode(buffer: Buffer): string {
    return this.encoding === 'utf8' ? buffer.toString('utf8') : iconv.decode(buffer, this.encoding);
  }

  private encode(text: string): Buffer {
    return this.encoding === 'utf8' ? Buffer.from(text, 'utf8') : iconv.encode(text, this.encoding);
  }
}
