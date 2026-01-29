import type { GatewayConfig } from './types.js';

export type { GatewayConfig } from './types.js';

const defaults: GatewayConfig = {
  port: 8667,
  host: '0.0.0.0',
  path: '/irc',
  maxClients: 1000,
  maxConnectionsPerIp: 10,
  quitMessage: 'Simple IRC Client',
  realname: 'Simple IRC Client user',
};

let config: GatewayConfig = { ...defaults };

export function loadConfig(userConfig: Partial<GatewayConfig> = {}): GatewayConfig {
  config = { ...defaults, ...userConfig };
  return config;
}

export function getConfig(): GatewayConfig {
  return config;
}
