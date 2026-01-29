import { WebSocket } from 'ws';
import { IrcClient, resolveClientHostname } from './irc-client.js';
import { getConfig } from './config.js';
import { encryptMessage, decryptMessage } from './encryption.js';
import { isValidEncoding } from './encoding.js';
import * as logger from './logger.js';
import type {
  ClientMessage,
  ClientCommand,
  ConnectCommand,
  DisconnectCommand,
  RawCommand,
  EncodingCommand,
  ServerMessage,
  IrcEvent,
} from './types.js';

let connectionIdCounter = 0;

export class ClientConnection {
  readonly id: string;
  readonly clientIp: string;
  private ws: WebSocket;
  private irc: IrcClient | null = null;
  private messageCount = 0;
  private messageWindowStart = Date.now();
  private destroyed = false;

  constructor(ws: WebSocket, clientIp: string) {
    this.id = `client-${++connectionIdCounter}`;
    this.clientIp = clientIp;
    this.ws = ws;

    this.ws.on('message', (data) => this.onMessage(data));
    this.ws.on('close', () => this.onClose());
    this.ws.on('error', (err) => this.onError(err));

    logger.info(`[${this.id}] Connected from ${clientIp}`);
  }

  private async onMessage(data: unknown): Promise<void> {
    if (this.destroyed) return;

    if (!this.checkRateLimit()) {
      logger.warn(`[${this.id}] Rate limit exceeded`);
      await this.sendGatewayEvent('error', 'Rate limit exceeded');
      return;
    }

    try {
      const message = await decryptMessage(data?.toString() ?? '');
      const clientMessage = message as ClientMessage;

      if (clientMessage.event === 'sic-client-event') {
        await this.handleCommand(clientMessage.data);
      }
    } catch (err) {
      logger.error(`[${this.id}] Failed to parse message: ${err}`);
    }
  }

  private checkRateLimit(): boolean {
    const config = getConfig();
    const now = Date.now();

    if (now - this.messageWindowStart > config.limits.messageRatePeriod) {
      this.messageCount = 0;
      this.messageWindowStart = now;
    }

    this.messageCount++;
    return this.messageCount <= config.limits.messageRateLimit;
  }

  private async handleCommand(command: ClientCommand): Promise<void> {
    switch (command.type) {
      case 'connect':
        await this.handleConnect(command as ConnectCommand);
        break;
      case 'disconnect':
        this.handleDisconnect(command as DisconnectCommand);
        break;
      case 'raw':
        this.handleRaw(command as RawCommand);
        break;
      case 'encoding':
        this.handleEncoding(command as EncodingCommand);
        break;
    }
  }

  private async handleConnect(command: ConnectCommand): Promise<void> {
    const config = getConfig();
    const { nick, username, realname, server } = command.data;

    if (!this.isServerAllowed(server.host, server.port)) {
      logger.warn(`[${this.id}] Server not allowed: ${server.host}:${server.port}`);
      await this.sendGatewayEvent('error', 'Server not allowed');
      return;
    }

    if (this.irc) {
      this.irc.destroy();
    }

    this.irc = new IrcClient();
    this.setupIrcHandlers();

    const webircParams = config.webirc.enabled
      ? {
          password: config.webirc.password,
          gateway: config.webirc.gateway,
          hostname: resolveClientHostname(this.clientIp),
          ip: this.clientIp,
        }
      : undefined;

    this.irc.connect({
      host: server.host,
      port: server.port,
      nick,
      username: username ?? nick,
      realname: realname ?? config.defaults.realname,
      encoding: server.encoding ?? config.defaults.encoding,
      tls: server.tls ?? false,
      password: server.password,
      pingInterval: config.defaults.pingInterval,
      pingTimeout: config.defaults.pingTimeout,
      webirc: webircParams,
    });

    logger.info(`[${this.id}] Connecting to ${server.host}:${server.port} as ${nick}`);
  }

  private handleDisconnect(command: DisconnectCommand): void {
    const config = getConfig();
    const reason = command.data?.reason ?? config.defaults.quitMessage;

    if (this.irc) {
      logger.info(`[${this.id}] Disconnecting: ${reason}`);
      this.irc.quit(reason);
      this.irc = null;
    }
  }

  private handleRaw(command: RawCommand): void {
    if (this.irc?.isConnected()) {
      this.irc.sendRaw(command.data.line);
    }
  }

  private handleEncoding(command: EncodingCommand): void {
    const encoding = command.data.encoding;

    if (!isValidEncoding(encoding)) {
      logger.warn(`[${this.id}] Invalid encoding: ${encoding}`);
      this.sendGatewayEvent('error', `Invalid encoding: ${encoding}`);
      return;
    }

    if (this.irc) {
      this.irc.setEncoding(encoding);
      logger.info(`[${this.id}] Encoding set to ${encoding}`);
    }
  }

  private isServerAllowed(host: string, port: number): boolean {
    const config = getConfig();

    if (config.upstream.allowAnyServer) {
      return true;
    }

    return config.upstream.allowedServers.some(
      (s) => s.host.toLowerCase() === host.toLowerCase() && s.port === port
    );
  }

  private setupIrcHandlers(): void {
    if (!this.irc) return;

    this.irc.on('socket_connected', () => {
      this.sendIrcEvent({ type: 'socket_connected' });
    });

    this.irc.on('connected', () => {
      this.sendIrcEvent({ type: 'connected' });
    });

    this.irc.on('socket_close', () => {
      this.sendIrcEvent({ type: 'socket_close' });
    });

    this.irc.on('close', () => {
      this.sendIrcEvent({ type: 'close' });
    });

    this.irc.on('raw', (line: string, fromServer: boolean) => {
      logger.irc(fromServer ? 'in' : 'out', this.id, line);

      if (fromServer) {
        this.sendIrcEvent({ type: 'raw', line });
      } else {
        this.sendServerEvent({ type: 'raw', line });
      }
    });

    this.irc.on('error', (error: Error) => {
      logger.error(`[${this.id}] IRC error: ${error.message}`);
      this.sendIrcEvent({ type: 'error', error: error.message });
    });
  }

  private async sendIrcEvent(event: IrcEvent): Promise<void> {
    await this.send({ event: 'sic-irc-event', data: event });
  }

  private async sendServerEvent(event: IrcEvent): Promise<void> {
    await this.send({ event: 'sic-server-event', data: event });
  }

  private async sendGatewayEvent(type: string, message: string): Promise<void> {
    await this.send({ event: 'sic-gateway-event', data: { type, message } });
  }

  private async send(message: ServerMessage): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) return;

    try {
      const encrypted = await encryptMessage(message);
      this.ws.send(encrypted);
    } catch (err) {
      logger.error(`[${this.id}] Failed to send message: ${err}`);
    }
  }

  private onClose(): void {
    logger.info(`[${this.id}] WebSocket closed`);
    this.destroy();
  }

  private onError(error: Error): void {
    logger.error(`[${this.id}] WebSocket error: ${error.message}`);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.irc) {
      this.irc.quit(getConfig().defaults.quitMessage);
      this.irc = null;
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}
