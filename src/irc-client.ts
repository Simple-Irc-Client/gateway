import { EventEmitter } from 'events';
import * as net from 'net';
import * as tls from 'tls';
import { decode, encode } from './encoding.js';

export interface IrcOptions {
  host: string;
  port: number;
  nick: string;
  username?: string;
  realname?: string;
  password?: string;
  tls?: boolean;
  encoding?: string;
  webirc?: { password: string; gateway: string; hostname: string; ip: string };
}

export class IrcClient extends EventEmitter {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private encoding = 'utf8';
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  connect(opts: IrcOptions): void {
    this.destroy();
    this.encoding = opts.encoding ?? 'utf8';
    this.buffer = Buffer.alloc(0);

    const socket = opts.tls
      ? tls.connect({ host: opts.host, port: opts.port, rejectUnauthorized: false })
      : net.connect({ host: opts.host, port: opts.port });

    this.socket = socket;

    socket.once('connect', () => {
      this.emit('socket_connected');

      if (opts.webirc) {
        const { password, gateway, hostname, ip } = opts.webirc;
        this.send(`WEBIRC ${password} ${gateway} ${hostname} ${ip}`);
      }
      if (opts.password) this.send(`PASS ${opts.password}`);

      this.send('CAP LS 302');
      this.send(`NICK ${opts.nick}`);
      this.send(`USER ${opts.username ?? opts.nick} 0 * :${opts.realname ?? opts.nick}`);

      this.pingTimer = setInterval(() => this.send(`PING :${Date.now()}`), 30000);
    });

    socket.on('data', (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      let idx: number;
      while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
        const line = decode(this.buffer.subarray(0, idx), this.encoding);
        this.buffer = this.buffer.subarray(idx + 2);
        if (line) this.handleLine(line);
      }
    });

    socket.on('close', () => {
      this.cleanup();
      this.emit('close');
    });

    socket.on('error', (err: Error) => this.emit('error', err));
  }

  private handleLine(line: string): void {
    this.emit('raw', line, true);

    if (line.startsWith('PING ')) {
      this.send(`PONG ${line.slice(5)}`);
    } else if (line.includes(' 001 ')) {
      this.emit('connected');
    }
  }

  send(line: string): void {
    if (this.socket?.writable) {
      this.socket.write(encode(`${line}\r\n`, this.encoding));
      this.emit('raw', line, false);
    }
  }

  quit(message?: string): void {
    if (this.socket?.writable) {
      this.send(message ? `QUIT :${message}` : 'QUIT');
      this.socket.end();
    }
    this.cleanup();
  }

  destroy(): void {
    this.cleanup();
    this.socket?.destroy();
    this.socket = null;
  }

  private cleanup(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  get connected(): boolean {
    return this.socket?.writable ?? false;
  }
}
