import { EventEmitter } from 'events';
import * as net from 'net';
import * as tls from 'tls';
import iconv from 'iconv-lite';

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
        this.send(`WEBIRC ${opts.webirc.password} ${opts.webirc.gateway} ${opts.webirc.hostname} ${opts.webirc.ip}`);
      }
      if (opts.password) this.send(`PASS ${opts.password}`);
      this.send('CAP LS 302');
      this.send(`NICK ${opts.nick}`);
      this.send(`USER ${opts.username ?? opts.nick} 0 * :${opts.realname ?? opts.nick}`);
      this.pingTimer = setInterval(() => this.send(`PING :${Date.now()}`), 30000);
    });

    socket.on('data', (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      let i: number;
      while ((i = this.buffer.indexOf('\r\n')) !== -1) {
        const line = this.decode(this.buffer.subarray(0, i));
        this.buffer = this.buffer.subarray(i + 2);
        if (line) {
          this.emit('raw', line, true);
          if (line.startsWith('PING ')) this.send(`PONG ${line.slice(5)}`);
          else if (line.includes(' 001 ')) this.emit('connected');
        }
      }
    });

    socket.on('close', () => { this.cleanup(); this.emit('close'); });
    socket.on('error', (err: Error) => this.emit('error', err));
  }

  send(line: string): void {
    if (this.socket?.writable) {
      this.socket.write(this.encode(`${line}\r\n`));
      this.emit('raw', line, false);
    }
  }

  quit(msg?: string): void {
    if (this.socket?.writable) {
      this.send(msg ? `QUIT :${msg}` : 'QUIT');
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
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private decode(buf: Buffer): string {
    return this.encoding === 'utf8' ? buf.toString('utf8') : iconv.decode(buf, this.encoding);
  }

  private encode(str: string): Buffer {
    return this.encoding === 'utf8' ? Buffer.from(str, 'utf8') : iconv.encode(str, this.encoding);
  }

  get connected(): boolean { return this.socket?.writable ?? false; }
}
