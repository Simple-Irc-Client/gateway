export interface Config {
  port: number;
  host: string;
  path: string;
  maxClients: number;
  maxConnectionsPerIp: number;
  webircPassword?: string;
  webircGateway?: string;
  allowedServers?: string[];
  quitMessage: string;
  realname: string;
}

const defaults: Config = {
  port: 8667,
  host: '0.0.0.0',
  path: '/irc',
  maxClients: 1000,
  maxConnectionsPerIp: 10,
  quitMessage: 'Simple IRC Client',
  realname: 'Simple IRC Client user',
};

let config: Config = { ...defaults };

export const loadConfig = (c: Partial<Config> = {}): Config => config = { ...defaults, ...c };
export const getConfig = (): Config => config;
