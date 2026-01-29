export interface GatewayConfig {
  port: number;
  host: string;
  path: string;
  maxClients: number;
  maxConnectionsPerIp: number;
  // WEBIRC settings (optional)
  webircPassword?: string;
  webircGateway?: string;
  // Upstream restrictions (if empty, allow any server)
  allowedServers?: string[]; // format: "host:port"
  // Defaults
  quitMessage: string;
  realname: string;
}

export interface ConnectParams {
  nick: string;
  username?: string;
  realname?: string;
  host: string;
  port: number;
  tls?: boolean;
  password?: string;
}
