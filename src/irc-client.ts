import { EventEmitter } from 'events';
import * as net from 'net';
import * as tls from 'tls';
import { toUtf8, fromUtf8 } from './encoding.js';
import { buildWebircCommand, resolveClientHostname } from './webirc.js';
import type { WebircParams } from './types.js';

export interface IrcClientOptions {
  host: string;
  port: number;
  nick: string;
  username: string;
  realname: string;
  encoding?: string;
  tls?: boolean;
  password?: string;
  pingInterval?: number;
  pingTimeout?: number;
  webirc?: WebircParams;
}

export interface IrcClientEvents {
  'socket_connected': () => void;
  'socket_close': () => void;
  'connected': (nick: string) => void;
  'close': () => void;
  'raw': (line: string, fromServer: boolean) => void;
  'error': (error: Error) => void;
}

export class IrcClient extends EventEmitter {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private options: IrcClientOptions | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private encoding: string = 'utf8';
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pingTimeout: ReturnType<typeof setTimeout> | null = null;
  private registered = false;

  connect(options: IrcClientOptions): void {
    if (this.socket) {
      this.destroy();
    }

    this.options = options;
    this.encoding = options.encoding ?? 'utf8';
    this.buffer = Buffer.alloc(0);
    this.registered = false;

    const connectOptions = {
      host: options.host,
      port: options.port,
      rejectUnauthorized: false,
    };

    if (options.tls) {
      this.socket = tls.connect(connectOptions, () => this.onSocketConnect());
    } else {
      this.socket = net.connect(connectOptions, () => this.onSocketConnect());
    }

    this.socket.on('data', (data: Buffer) => this.onData(data));
    this.socket.on('close', () => this.onSocketClose());
    this.socket.on('error', (error: Error) => this.onSocketError(error));
  }

  private onSocketConnect(): void {
    this.emit('socket_connected');

    if (!this.options) return;

    if (this.options.webirc) {
      const webircCmd = buildWebircCommand(this.options.webirc);
      this.sendRaw(webircCmd);
    }

    if (this.options.password) {
      this.sendRaw(`PASS ${this.options.password}`);
    }

    this.sendRaw('CAP LS 302');
    this.sendRaw(`NICK ${this.options.nick}`);
    this.sendRaw(`USER ${this.options.username} 0 * :${this.options.realname}`);

    this.startPingInterval();
  }

  private onData(data: Buffer): void {
    this.resetPingTimeout();
    this.buffer = Buffer.concat([this.buffer, data]);

    let lineEnd: number;
    while ((lineEnd = this.buffer.indexOf('\r\n')) !== -1) {
      const lineBuffer = this.buffer.subarray(0, lineEnd);
      this.buffer = this.buffer.subarray(lineEnd + 2);

      const line = toUtf8(lineBuffer, this.encoding);
      if (line.length > 0) {
        this.processLine(line);
      }
    }
  }

  private processLine(line: string): void {
    this.emit('raw', line, true);

    if (line.startsWith('PING ')) {
      const pingArg = line.substring(5);
      this.sendRaw(`PONG ${pingArg}`);
      return;
    }

    if (!this.registered && line.includes(' 001 ')) {
      this.registered = true;
      this.emit('connected', this.options?.nick ?? '');
    }
  }

  sendRaw(line: string): void {
    if (!this.socket || this.socket.destroyed) return;

    const buffer = fromUtf8(`${line}\r\n`, this.encoding);
    this.socket.write(buffer);
    this.emit('raw', line, false);
  }

  setEncoding(encoding: string): void {
    this.encoding = encoding;
  }

  private onSocketClose(): void {
    this.cleanup();
    this.emit('socket_close');
    this.emit('close');
  }

  private onSocketError(error: Error): void {
    this.emit('error', error);
  }

  private startPingInterval(): void {
    const interval = (this.options?.pingInterval ?? 30) * 1000;
    this.pingInterval = setInterval(() => {
      if (this.socket && !this.socket.destroyed) {
        this.sendRaw(`PING :${Date.now()}`);
      }
    }, interval);
  }

  private resetPingTimeout(): void {
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
    }

    const timeout = (this.options?.pingTimeout ?? 120) * 1000;
    this.pingTimeout = setTimeout(() => {
      this.emit('error', new Error('Ping timeout'));
      this.destroy();
    }, timeout);
  }

  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout);
      this.pingTimeout = null;
    }
  }

  quit(message?: string): void {
    if (this.socket && !this.socket.destroyed) {
      const quitCmd = message ? `QUIT :${message}` : 'QUIT';
      this.sendRaw(quitCmd);
      this.socket.end();
    }
    this.cleanup();
  }

  destroy(): void {
    this.cleanup();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }
}

export { resolveClientHostname };
