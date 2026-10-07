export interface Config {
  port: number;
  /** Bind address */
  host: string;
  /** WebSocket path */
  path: string;
  maxClients: number;
  maxConnectionsPerIp: number;
  webircPassword?: string;
  webircGateway?: string;
  /** "host:port" entries; empty allows every server */
  allowedServers?: string[];
  /** Read the client IP from X-Forwarded-For; enable only behind a reverse proxy */
  trustProxy: boolean;
  /** Allowed WebSocket Origin values; empty allows every origin */
  allowedOrigins?: string[];
  /** Refuse IRC servers on private or reserved addresses (SSRF protection) */
  blockPrivateHosts: boolean;
  quitMessage: string;
  /** Refuse connections that don't ask for TLS to the IRC server */
  enforceTls: boolean;
  /** Seconds the IRC server may stay silent after our PING */
  pongTimeout: number;
  /** Seconds between WebSocket pings */
  wsPingInterval: number;
  /** Seconds to wait for a WebSocket pong before disconnecting */
  wsPongTimeout: number;
  /** Seconds for the browser to send NICK/USER; 0 disables */
  registrationTimeout: number;
  /** Answer RFC 1413 ident queries from IRC servers */
  identdEnabled: boolean;
  identdPort: number;
  /** Seconds an ident query connection may stay open */
  identdTimeout: number;
}

const DEFAULT_CONFIG: Config = {
  port: 8667,
  host: '0.0.0.0',
  path: '/webirc',
  maxClients: 1000,
  maxConnectionsPerIp: 10,
  trustProxy: false,
  allowedOrigins: ['https://app.simpleircclient.com'],
  blockPrivateHosts: true,
  quitMessage: 'Simple IRC Client',
  enforceTls: false,
  pongTimeout: 120,
  wsPingInterval: 30,
  wsPongTimeout: 120,
  registrationTimeout: 30,
  identdEnabled: false,
  identdPort: 113,
  identdTimeout: 30,
};

let currentConfig: Config = { ...DEFAULT_CONFIG };

/** Replaces the active configuration with the defaults overridden by every defined value in `overrides`. */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
  currentConfig = { ...DEFAULT_CONFIG, ...defined };
  return currentConfig;
}

export function getConfig(): Config {
  return currentConfig;
}
