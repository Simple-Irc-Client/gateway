import { WebSocketServer, WebSocket } from 'ws';
import type { Duplex } from 'stream';
import { createServer, type IncomingMessage } from 'http';
import { getConfig } from './config.js';
import { IrcClient } from './irc-client.js';
import * as log from './logger.js';

interface Client {
  id: string;
  ip: string;
  ws: WebSocket;
  irc: IrcClient | null;
}

let nextId = 0;

export class Gateway {
  private server = createServer((_, res) => res.end('IRC Gateway'));
  private wss = new WebSocketServer({ noServer: true });
  private clients = new Map<string, Client>();
  private ipCounts = new Map<string, number>();

  constructor() {
    this.server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const cfg = getConfig();
    const path = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
    const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.socket.remoteAddress ?? '127.0.0.1').trim();

    if (path !== cfg.path) return void (socket.write('HTTP/1.1 404 Not Found\r\n\r\n'), socket.destroy());
    if ((this.ipCounts.get(ip) ?? 0) >= cfg.maxConnectionsPerIp) return void (socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'), socket.destroy());
    if (this.clients.size >= cfg.maxClients) return void (socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'), socket.destroy());

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const id = `c${++nextId}`;
      const client: Client = { id, ip, ws, irc: null };
      this.clients.set(id, client);
      this.ipCounts.set(ip, (this.ipCounts.get(ip) ?? 0) + 1);
      log.info(`[${id}] Connected from ${ip} (${this.clients.size} clients)`);

      ws.on('message', (data) => this.onMessage(client, data.toString()));
      ws.on('close', () => {
        client.irc?.quit(cfg.quitMessage);
        this.clients.delete(id);
        const cnt = (this.ipCounts.get(ip) ?? 1) - 1;
        if (cnt <= 0) this.ipCounts.delete(ip); else this.ipCounts.set(ip, cnt);
        log.info(`[${id}] Disconnected (${this.clients.size} clients)`);
      });
    });
  }

  private onMessage(client: Client, raw: string): void {
    const cfg = getConfig();
    let msg: { event?: string; data?: Record<string, unknown> };
    try { msg = JSON.parse(raw) as typeof msg; } catch { return; }
    if (msg.event !== 'sic-client-event' || !msg.data) return;

    const d = msg.data;
    const type = d.type as string;
    // Support nested event format from core: { type, event: { nick, server: { host, port, ... } } }
    const evt = (d.event as Record<string, unknown>) ?? d;
    const srv = (evt.server as Record<string, unknown>) ?? evt;

    if (type === 'disconnect') {
      client.irc?.quit((evt.quitReason as string) ?? cfg.quitMessage);
      client.irc = null;
    } else if (type === 'raw' && evt.rawData) {
      client.irc?.send(evt.rawData as string);
    } else if (type === 'connect' && srv.host && srv.port && evt.nick) {
      const host = srv.host as string, port = srv.port as number, nick = evt.nick as string;

      if (cfg.allowedServers?.length && !cfg.allowedServers.includes(`${host}:${port}`)) {
        return void this.send(client.ws, 'sic-gateway-event', { type: 'error', message: 'Server not allowed' });
      }

      client.irc?.destroy();
      const irc = client.irc = new IrcClient();

      irc.on('socket_connected', () => this.send(client.ws, 'sic-irc-event', { type: 'socket_connected' }));
      irc.on('connected', () => this.send(client.ws, 'sic-irc-event', { type: 'connected' }));
      irc.on('close', () => this.send(client.ws, 'sic-irc-event', { type: 'close' }));
      irc.on('error', (e: Error) => this.send(client.ws, 'sic-irc-event', { type: 'error', error: e.message }));
      irc.on('raw', (line: string, fromServer: boolean) => {
        log.debug(`[${client.id}] ${fromServer ? '>>' : '<<'} ${line}`);
        this.send(client.ws, fromServer ? 'sic-irc-event' : 'sic-server-event', { type: 'raw', line });
      });

      irc.connect({
        host, port, nick,
        username: evt.username as string | undefined,
        realname: (evt.realname as string) ?? cfg.realname,
        password: evt.password as string | undefined,
        tls: srv.tls as boolean | undefined,
        encoding: srv.encoding as string | undefined,
        webirc: cfg.webircPassword ? { password: cfg.webircPassword, gateway: cfg.webircGateway ?? 'gateway', hostname: `${client.ip}.web`, ip: client.ip } : undefined,
      });
      log.info(`[${client.id}] Connecting to ${host}:${port} as ${nick}`);
    }
  }

  private send(ws: WebSocket, event: string, data: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, data }));
  }

  start(): void {
    const cfg = getConfig();
    this.server.listen(cfg.port, cfg.host, () => log.success(`Gateway on ${cfg.host}:${cfg.port}${cfg.path}`));
  }

  stop(): void {
    for (const c of this.clients.values()) { c.irc?.quit(getConfig().quitMessage); c.ws.close(); }
    this.clients.clear();
    this.wss.close();
    this.server.close();
  }
}
