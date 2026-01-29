export type IrcEventType = 'connected' | 'close' | 'socket_close' | 'socket_connected' | 'raw' | 'error';

export type ClientCommandType = 'connect' | 'disconnect' | 'raw' | 'encoding';

export interface GatewayConfig {
  port: number;
  host: string;
  path: string;
  allowedOrigins: string[];
  encryption: {
    enabled: boolean;
    key: string;
  };
  webirc: {
    enabled: boolean;
    password: string;
    gateway: string;
  };
  upstream: {
    allowAnyServer: boolean;
    defaultServer?: {
      host: string;
      port: number;
      tls: boolean;
    };
    allowedServers: Array<{
      host: string;
      port: number;
      tls?: boolean;
    }>;
  };
  limits: {
    maxClients: number;
    maxConnectionsPerIp: number;
    messageRateLimit: number;
    messageRatePeriod: number;
  };
  defaults: {
    quitMessage: string;
    realname: string;
    encoding: BufferEncoding;
    pingInterval: number;
    pingTimeout: number;
  };
}

export interface ServerInfo {
  host: string;
  port: number;
  tls?: boolean;
  encoding?: string;
  password?: string;
}

export interface ConnectCommand {
  type: 'connect';
  data: {
    nick: string;
    username?: string;
    realname?: string;
    server: ServerInfo;
  };
}

export interface DisconnectCommand {
  type: 'disconnect';
  data?: {
    reason?: string;
  };
}

export interface RawCommand {
  type: 'raw';
  data: {
    line: string;
  };
}

export interface EncodingCommand {
  type: 'encoding';
  data: {
    encoding: string;
  };
}

export type ClientCommand = ConnectCommand | DisconnectCommand | RawCommand | EncodingCommand;

export interface ClientMessage {
  event: 'sic-client-event';
  data: ClientCommand;
}

export interface IrcEvent {
  type: IrcEventType;
  line?: string;
  error?: string;
}

export interface ServerMessage {
  event: 'sic-irc-event' | 'sic-server-event' | 'sic-gateway-event';
  data: IrcEvent | { type: string; message: string };
}

export interface WebircParams {
  password: string;
  gateway: string;
  hostname: string;
  ip: string;
}
