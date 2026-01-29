import type { GatewayConfig } from './types.js';

export type { GatewayConfig } from './types.js';

const defaultConfig: GatewayConfig = {
  port: 8667,
  host: '0.0.0.0',
  path: '/irc',
  allowedOrigins: [
    'file://',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
  ],
  encryption: {
    enabled: false,
    key: '',
  },
  webirc: {
    enabled: false,
    password: '',
    gateway: 'sic-gateway',
  },
  upstream: {
    allowAnyServer: true,
    allowedServers: [],
  },
  limits: {
    maxClients: 1000,
    maxConnectionsPerIp: 10,
    messageRateLimit: 10,
    messageRatePeriod: 1000,
  },
  defaults: {
    quitMessage: 'Simple IRC Client (https://simpleircclient.com)',
    realname: 'Simple IRC Client user',
    encoding: 'utf8',
    pingInterval: 30,
    pingTimeout: 120,
  },
};

let config: GatewayConfig = { ...defaultConfig };

export function loadConfig(userConfig: Partial<GatewayConfig> = {}): GatewayConfig {
  config = deepMerge(defaultConfig, userConfig) as GatewayConfig;
  return config;
}

export function getConfig(): GatewayConfig {
  return config;
}

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

function deepMerge<T extends object>(target: T, source: DeepPartial<T>): T {
  const result = { ...target } as T;

  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue !== null &&
      sourceValue !== undefined &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue as object, sourceValue as object) as T[keyof T];
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[keyof T];
    }
  }

  return result;
}
