import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server as HttpServer, type IncomingMessage } from 'http';
import { getConfig } from './config.js';
import { ClientConnection } from './client-connection.js';
import * as logger from './logger.js';

export class Gateway {
  private httpServer: HttpServer;
  private wss: WebSocketServer;
  private clients: Map<string, ClientConnection> = new Map();
  private ipConnectionCounts: Map<string, number> = new Map();

  constructor() {
    this.httpServer = createServer(this.handleHttpRequest.bind(this));
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', this.handleUpgrade.bind(this));
  }

  private handleHttpRequest(_req: IncomingMessage, res: import('http').ServerResponse): void {
    const config = getConfig();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        name: 'sic-gateway',
        version: '1.0.0',
        websocket: config.path,
      })
    );
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: import('stream').Duplex,
    head: Buffer
  ): void {
    const config = getConfig();
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

    if (url.pathname !== config.path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const origin = request.headers.origin;
    if (origin && !this.isOriginAllowed(origin)) {
      logger.warn(`Rejected connection from origin: ${origin}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const clientIp = this.getClientIp(request);

    if (!this.checkConnectionLimit(clientIp)) {
      logger.warn(`Connection limit exceeded for IP: ${clientIp}`);
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    if (this.clients.size >= config.limits.maxClients) {
      logger.warn('Max clients reached, rejecting connection');
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.onConnection(ws, clientIp);
    });
  }

  private isOriginAllowed(origin: string): boolean {
    const config = getConfig();

    if (config.allowedOrigins.length === 0) {
      return true;
    }

    return config.allowedOrigins.some((allowed) => {
      if (allowed.includes('*')) {
        const pattern = new RegExp('^' + allowed.replace(/\*/g, '.*') + '$');
        return pattern.test(origin);
      }
      return allowed === origin;
    });
  }

  private getClientIp(request: IncomingMessage): string {
    const forwardedFor = request.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
      return ips.split(',')[0].trim();
    }

    const realIp = request.headers['x-real-ip'];
    if (realIp) {
      return Array.isArray(realIp) ? realIp[0] : realIp;
    }

    return request.socket.remoteAddress ?? '127.0.0.1';
  }

  private checkConnectionLimit(ip: string): boolean {
    const config = getConfig();
    const count = this.ipConnectionCounts.get(ip) ?? 0;
    return count < config.limits.maxConnectionsPerIp;
  }

  private onConnection(ws: WebSocket, clientIp: string): void {
    const count = this.ipConnectionCounts.get(clientIp) ?? 0;
    this.ipConnectionCounts.set(clientIp, count + 1);

    const client = new ClientConnection(ws, clientIp);
    this.clients.set(client.id, client);

    ws.on('close', () => {
      this.clients.delete(client.id);

      const newCount = (this.ipConnectionCounts.get(clientIp) ?? 1) - 1;
      if (newCount <= 0) {
        this.ipConnectionCounts.delete(clientIp);
      } else {
        this.ipConnectionCounts.set(clientIp, newCount);
      }

      logger.info(`Active clients: ${this.clients.size}`);
    });

    logger.info(`Active clients: ${this.clients.size}`);
  }

  start(): void {
    const config = getConfig();

    this.httpServer.listen(config.port, config.host, () => {
      logger.success(`Gateway listening on ${config.host}:${config.port}${config.path}`);
      logger.info(`Allowed origins: ${config.allowedOrigins.join(', ') || 'any'}`);
      logger.info(`Max clients: ${config.limits.maxClients}`);
      logger.info(`WEBIRC: ${config.webirc.enabled ? 'enabled' : 'disabled'}`);
    });
  }

  stop(): void {
    for (const client of this.clients.values()) {
      client.destroy();
    }
    this.clients.clear();
    this.ipConnectionCounts.clear();

    this.wss.close();
    this.httpServer.close();

    logger.info('Gateway stopped');
  }

  getStats(): { clients: number; ips: number } {
    return {
      clients: this.clients.size,
      ips: this.ipConnectionCounts.size,
    };
  }
}
