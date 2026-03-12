import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, getConfig } from '../config.js';

describe('config', () => {
  beforeEach(() => {
    loadConfig({});
  });

  it('returns default config', () => {
    const config = getConfig();
    expect(config.port).toBe(8667);
    expect(config.host).toBe('0.0.0.0');
    expect(config.path).toBe('/webirc');
    expect(config.maxClients).toBe(1000);
    expect(config.maxConnectionsPerIp).toBe(10);
  });

  it('merges user config with defaults', () => {
    loadConfig({ port: 9000, maxClients: 500 });
    const config = getConfig();
    expect(config.port).toBe(9000);
    expect(config.maxClients).toBe(500);
    expect(config.host).toBe('0.0.0.0'); // default preserved
  });

  it('sets optional webirc config', () => {
    loadConfig({ webircPassword: 'secret', webircGateway: 'mygateway' });
    const config = getConfig();
    expect(config.webircPassword).toBe('secret');
    expect(config.webircGateway).toBe('mygateway');
  });

  it('sets allowed servers', () => {
    loadConfig({ allowedServers: ['irc.libera.chat:6697', 'irc.oftc.net:6697'] });
    const config = getConfig();
    expect(config.allowedServers).toHaveLength(2);
    expect(config.allowedServers).toContain('irc.libera.chat:6697');
  });
});
