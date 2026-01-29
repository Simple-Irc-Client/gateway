import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type IncomingMessage } from 'http';
import { getConfig } from './config.js';
import { IrcClient } from './irc-client.js';
import * as log from './logger.js';
import type { ConnectParams } from './types.js';

interface Client {
  id: string;
  ip: string;
  ws: WebSocket;
  irc: IrcClient | null;
}

let clientId = 0;

export class Gateway {
  private server = createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('IRC Gateway');
  });
  private wss = new WebSocketServer({ noServer: true });
  private clients = new Map<string, Client>();
  private ipCounts = new Map<string, number>();

  constructor() {
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  private handleUpgrade(req: IncomingMessage, socket: any, head: Buffer): void {
    const config = getConfig();
    const path = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;

    if (path !== config.path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const ip = this.getIp(req);
    const count = this.ipCounts.get(ip) ?? 0;

    if (count >= config.maxConnectionsPerIp) {
      log.warn(`Too many connections from ${ip}`);
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    if (this.clients.size >= config.maxClients) {
      log.warn('Max clients reached');
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => this.addClient(ws, ip));
  }

  private getIp(req: IncomingMessage): string {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return (Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim();
    return req.socket.remoteAddress ?? '127.0.0.1';
  }

  private addClient(ws: WebSocket, ip: string): void {
    const id = `c${++clientId}`;
    const client: Client = { id, ip, ws, irc: null };

    this.clients.set(id, client);
    this.ipCounts.set(ip, (this.ipCounts.get(ip) ?? 0) + 1);
    log.info(`[${id}] Connected from ${ip} (${this.clients.size} clients)`);

    ws.on('message', (data) => this.onMessage(client, data.toString()));
    ws.on('close', () => this.removeClient(client));
    ws.on('error', (err) => log.error(`[${id}] WS error: ${err.message}`));
  }

  private removeClient(client: Client): void {
    client.irc?.quit(getConfig().quitMessage);
    this.clients.delete(client.id);

    const count = (this.ipCounts.get(client.ip) ?? 1) - 1;
    if (count <= 0) this.ipCounts.delete(client.ip);
    else this.ipCounts.set(client.ip, count);

    log.info(`[${client.id}] Disconnected (${this.clients.size} clients)`);
  }

  private onMessage(client: Client, raw: string): void {
    let msg: { event: string; data: any };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.event !== 'sic-client-event') return;

    const { type, ...data } = msg.data;

    switch (type) {
      case 'connect':
        this.handleConnect(client, data as ConnectParams);
        break;
      case 'disconnect':
        client.irc?.quit(data.reason ?? getConfig().quitMessage);
        client.irc = null;
        break;
      case 'raw':
        client.irc?.send(data.line);
        break;
    }
  }

  private handleConnect(client: Client, params: ConnectParams): void {
    const config = getConfig();

    if (config.allowedServers?.length) {
      const allowed = config.allowedServers.some(
        (s) => s.toLowerCase() === `${params.host}:${params.port}`.toLowerCase()
      );
      if (!allowed) {
        this.send(client.ws, 'sic-gateway-event', { type: 'error', message: 'Server not allowed' });
        return;
      }
    }

    client.irc?.destroy();
    client.irc = new IrcClient();

    const irc = client.irc;

    irc.on('socket_connected', () => this.send(client.ws, 'sic-irc-event', { type: 'socket_connected' }));
    irc.on('connected', () => this.send(client.ws, 'sic-irc-event', { type: 'connected' }));
    irc.on('close', () => this.send(client.ws, 'sic-irc-event', { type: 'close' }));
    irc.on('error', (err: Error) => this.send(client.ws, 'sic-irc-event', { type: 'error', error: err.message }));
    irc.on('raw', (line: string, fromServer: boolean) => {
      log.debug(`[${client.id}] ${fromServer ? '>>' : '<<'} ${line}`);
      this.send(client.ws, fromServer ? 'sic-irc-event' : 'sic-server-event', { type: 'raw', line });
    });

    const webirc = config.webircPassword
      ? { password: config.webircPassword, gateway: config.webircGateway ?? 'gateway', hostname: `${client.ip}.web`, ip: client.ip }
      : undefined;

    irc.connect({
      host: params.host,
      port: params.port,
      nick: params.nick,
      username: params.username,
      realname: params.realname ?? config.realname,
      password: params.password,
      tls: params.tls,
      webirc,
    });

    log.info(`[${client.id}] Connecting to ${params.host}:${params.port} as ${params.nick}`);
  }

  private send(ws: WebSocket, event: string, data: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event, data }));
    }
  }

  start(): void {
    const config = getConfig();
    this.server.listen(config.port, config.host, () => {
      log.success(`Gateway running on ${config.host}:${config.port}${config.path}`);
    });
  }

  stop(): void {
    for (const client of this.clients.values()) {
      client.irc?.quit(getConfig().quitMessage);
      client.ws.close();
    }
    this.clients.clear();
    this.wss.close();
    this.server.close();
  }
}
