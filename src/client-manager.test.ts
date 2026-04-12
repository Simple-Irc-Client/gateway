/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Client Manager Tests
 *
 * Tests for client lifecycle management, rate limiting, and timeout functionality
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClientManager } from './client-manager.js';
import { RATE_LIMIT_MAX_MESSAGES, RATE_LIMIT_WINDOW_MS } from './constants.js';

// Mock WebSocket class for testing
class MockWebSocket {
  readyState = 1; // OPEN
  
  sentMessages: string[] = [];
  closed = false;
  
  // Don't call super() to avoid actual WebSocket connection
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor, @typescript-eslint/no-empty-function
  constructor() {}

  send(message: string): void {
    this.sentMessages.push(message);
  }
  
  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
  }
  
  terminate(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
  }
  
  ping(): void {
    // Mock ping method
  }
}

describe('ClientManager', () => {
  let clientManager: ClientManager;
  let mockWebSocket: MockWebSocket;

  beforeEach(() => {
    clientManager = new ClientManager();
    mockWebSocket = new MockWebSocket();
    
    // Mock timers
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('Client Lifecycle', () => {
    it('creates and tracks clients', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      expect(client.id).toMatch(/^c\d+$/);
      expect(client.ipAddress).toBe('127.0.0.1');
      expect(client.webSocket).toBe(mockWebSocket);
      expect(client.ircClient).toBeNull();
      expect(client.serverConfig).toEqual(serverConfig);
      expect(client.identUsername).toBe('testuser');
      expect(client.isRegistered).toBe(false);

      // Check that client is tracked
      expect(clientManager.getClient(client.id)).toBe(client);
      expect(clientManager.getAllClients()).toContain(client);
    });

    it('generates unique client IDs', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client1 = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'user1');
      const client2 = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'user2');

      expect(client1.id).not.toBe(client2.id);
      expect(clientManager.getAllClients().length).toBe(2);
    });

    it('removes clients and cleans up resources', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      // Set up some timers
      clientManager.startWsPing(client, 30, 5);
      clientManager.startRegistrationTimeout(client, 10, 'Test quit');
      clientManager.resetIdleTimeout(client, 30, 'Test quit');

      expect(client.wsPingTimer).not.toBeNull();
      expect(client.registrationTimer).not.toBeNull();
      expect(client.idleTimer).not.toBeNull();

      // Remove client
      clientManager.removeClient(client);

      expect(client.wsPingTimer).toBeNull();
      expect(client.registrationTimer).toBeNull();
      expect(client.idleTimer).toBeNull();
      expect(clientManager.getClient(client.id)).toBeUndefined();
      expect(clientManager.getAllClients()).not.toContain(client);
    });

    it('tracks connections per IP address', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };

      // Create clients from different IPs
      const client1 = clientManager.createClient(mockWebSocket as any, '192.168.1.1', serverConfig, 'user1');
      const client2 = clientManager.createClient(mockWebSocket as any, '192.168.1.1', serverConfig, 'user2');
      const client3 = clientManager.createClient(mockWebSocket as any, '10.0.0.1', serverConfig, 'user3');

      expect(clientManager.getIpConnectionCount('192.168.1.1')).toBe(2);
      expect(clientManager.getIpConnectionCount('10.0.0.1')).toBe(1);
      expect(clientManager.getIpConnectionCount('1.2.3.4')).toBe(0);

      // Remove one client from first IP
      clientManager.removeClient(client1);
      expect(clientManager.getIpConnectionCount('192.168.1.1')).toBe(1);

      // Remove last client from first IP
      clientManager.removeClient(client2);
      expect(clientManager.getIpConnectionCount('192.168.1.1')).toBe(0);

      // Remove client from second IP
      clientManager.removeClient(client3);
      expect(clientManager.getIpConnectionCount('10.0.0.1')).toBe(0);
    });
  });

  describe('Message Handling and Rate Limiting', () => {
    it('allows messages within rate limit', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      // Mock Date.now() to return controlled values
      const mockDateNow = vi.spyOn(Date, 'now');
      const currentTime = client.rateLimitWindowStart;

      // Send messages within limit
      for (let i = 0; i < RATE_LIMIT_MAX_MESSAGES; i++) {
        mockDateNow.mockReturnValue(currentTime + i * 100);
        const result = clientManager.handleClientMessage(client, `MESSAGE ${i}`);
        expect(result).toBe(true);
      }

      expect(client.messageCount).toBe(RATE_LIMIT_MAX_MESSAGES);
      mockDateNow.mockRestore();
    });

    it('blocks messages exceeding rate limit', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      // Mock Date.now() to return controlled values
      const mockDateNow = vi.spyOn(Date, 'now');
      const currentTime = client.rateLimitWindowStart;

      // Fill up the rate limit window (all within the same window)
      for (let i = 0; i < RATE_LIMIT_MAX_MESSAGES; i++) {
        mockDateNow.mockReturnValue(currentTime + i * 10);
        clientManager.handleClientMessage(client, `MESSAGE ${i}`);
      }

      // Next message should be blocked (still within the same window)
      mockDateNow.mockReturnValue(currentTime + RATE_LIMIT_MAX_MESSAGES * 10);
      const result = clientManager.handleClientMessage(client, 'MESSAGE extra');
      
      expect(result).toBe(false);
      expect(client.messageCount).toBe(RATE_LIMIT_MAX_MESSAGES + 1);

      mockDateNow.mockRestore();
    });

    it('resets rate limit after window expires', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      // Fill up the rate limit window
      for (let i = 0; i < RATE_LIMIT_MAX_MESSAGES; i++) {
        clientManager.handleClientMessage(client, `MESSAGE ${i}`);
      }

      // Advance time past the rate limit window
      vi.advanceTimersByTime(RATE_LIMIT_WINDOW_MS + 1);

      // Should be able to send messages again
      const result = clientManager.handleClientMessage(client, 'MESSAGE after reset');
      expect(result).toBe(true);
      expect(client.messageCount).toBe(1);
    });

    it('detects registration commands', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      expect(client.isRegistered).toBe(false);

      // NICK command should complete registration
      const nickResult = clientManager.checkRegistration(client, 'NICK testuser');
      expect(nickResult).toBe(true);
      expect(client.isRegistered).toBe(true);

      // USER command should also complete registration
      const client2 = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser2');
      const userResult = clientManager.checkRegistration(client2, 'USER testuser 0 * :Test User');
      expect(userResult).toBe(true);
      expect(client2.isRegistered).toBe(true);

      // Non-registration commands should return false
      const privmsgResult = clientManager.checkRegistration(client, 'PRIVMSG #channel :hello');
      expect(privmsgResult).toBe(false);
    });
  });

  describe('WebSocket Keepalive', () => {
    it('starts and stops WebSocket ping/pong timers', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      // Start ping timer
      clientManager.startWsPing(client, 30, 5);
      expect(client.wsPingTimer).not.toBeNull();

      // Advance time to trigger a ping
      vi.advanceTimersByTime(30 * 1000);

      // Should have called ping (WebSocket ping doesn't send string messages)
      expect(mockWebSocket.sentMessages).not.toContain('ping');

      // Stop ping timer
      clientManager.stopWsPing(client);
      expect(client.wsPingTimer).toBeNull();
      expect(client.wsPongTimer).toBeNull();
    });

    it('handles pong responses', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      clientManager.startWsPing(client, 30, 5);
      
      // Trigger a ping
      vi.advanceTimersByTime(30 * 1000);
      expect(client.wsPongTimer).not.toBeNull();

      // Simulate pong response
      clientManager.clearWsPongTimer(client);
      expect(client.wsPongTimer).toBeNull();
    });

    it('terminates connection on pong timeout', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      clientManager.startWsPing(client, 30, 5);
      
      // Trigger a ping
      vi.advanceTimersByTime(30 * 1000);
      
      // Advance to pong timeout
      vi.advanceTimersByTime(5 * 1000);

      // Connection should be terminated
      expect(mockWebSocket.closed).toBe(true);
    });
  });

  describe('Registration Timeout', () => {
    it('closes connection when registration timeout expires', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      clientManager.startRegistrationTimeout(client, 10, 'Registration timeout');

      // Advance time to trigger timeout
      vi.advanceTimersByTime(10 * 1000);

      // Connection should be closed and error sent
      expect(mockWebSocket.closed).toBe(true);
      expect(mockWebSocket.sentMessages).toContain('ERROR :Registration timeout');
    });

    it('does not close connection when client registers in time', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      clientManager.startRegistrationTimeout(client, 10, 'Registration timeout');

      // Client registers before timeout
      vi.advanceTimersByTime(5 * 1000); // Halfway through timeout period
      clientManager.checkRegistration(client, 'NICK testuser');

      // Advance remaining time - should not close connection
      vi.advanceTimersByTime(6 * 1000);

      expect(mockWebSocket.closed).toBe(false);
      expect(client.isRegistered).toBe(true);
    });

    it('does not start timeout when timeout is 0 or negative', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      clientManager.startRegistrationTimeout(client, 0, 'Registration timeout');
      expect(client.registrationTimer).toBeNull();

      clientManager.startRegistrationTimeout(client, -1, 'Registration timeout');
      expect(client.registrationTimer).toBeNull();
    });
  });

  describe('Idle Timeout', () => {
    it('closes connection when idle timeout expires', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      clientManager.resetIdleTimeout(client, 10, 'Idle timeout');

      // Advance time to trigger timeout
      vi.advanceTimersByTime(10 * 1000);

      // Connection should be closed and error sent
      expect(mockWebSocket.closed).toBe(true);
      expect(mockWebSocket.sentMessages).toContain('ERROR :Idle timeout (10s)');
    });

    it('resets idle timeout on meaningful traffic', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      clientManager.resetIdleTimeout(client, 10, 'Idle timeout');

      // Advance halfway through timeout period
      vi.advanceTimersByTime(5 * 1000);

      // Reset timeout due to meaningful traffic
      clientManager.resetIdleTimeout(client, 10, 'Idle timeout');

      // Advance another 5 seconds - should not timeout yet
      vi.advanceTimersByTime(5 * 1000);
      expect(mockWebSocket.closed).toBe(false);

      // Advance remaining 5 seconds - should timeout now
      vi.advanceTimersByTime(5 * 1000);
      expect(mockWebSocket.closed).toBe(true);
    });

    it('does not start timeout when timeout is 0 or negative', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      clientManager.resetIdleTimeout(client, 0, 'Idle timeout');
      expect(client.idleTimer).toBeNull();

      clientManager.resetIdleTimeout(client, -1, 'Idle timeout');
      expect(client.idleTimer).toBeNull();
    });
  });

  describe('clientCount', () => {
    it('returns the number of connected clients without allocating an array', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };

      expect(clientManager.clientCount).toBe(0);

      const client1 = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'user1');
      expect(clientManager.clientCount).toBe(1);

      clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'user2');
      expect(clientManager.clientCount).toBe(2);

      clientManager.removeClient(client1);
      expect(clientManager.clientCount).toBe(1);
    });
  });

  describe('Removed flag', () => {
    it('sets removed flag on removeClient', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      expect(client.removed).toBe(false);
      clientManager.removeClient(client);
      expect(client.removed).toBe(true);
    });

    it('removeClient is idempotent (double-remove does not throw)', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      clientManager.removeClient(client);
      clientManager.removeClient(client);
      expect(client.removed).toBe(true);
      expect(clientManager.clientCount).toBe(0);
    });

    it('registration timeout callback does not fire after removal', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      clientManager.startRegistrationTimeout(client, 10, 'Test quit');
      clientManager.removeClient(client);

      vi.advanceTimersByTime(10 * 1000);

      expect(mockWebSocket.closed).toBe(false);
      expect(mockWebSocket.sentMessages).not.toContain('ERROR :Registration timeout');
    });

    it('idle timeout callback does not fire after removal', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      clientManager.resetIdleTimeout(client, 10, 'Test quit');
      clientManager.removeClient(client);

      vi.advanceTimersByTime(10 * 1000);

      expect(mockWebSocket.closed).toBe(false);
      expect(mockWebSocket.sentMessages.length).toBe(0);
    });

    it('ping timer callback does not fire after removal', () => {
      const serverConfig = { host: 'irc.example.com', port: 6667, tls: true, encoding: 'utf8' };
      const client = clientManager.createClient(mockWebSocket as any, '127.0.0.1', serverConfig, 'testuser');

      clientManager.startWsPing(client, 30, 5);
      clientManager.removeClient(client);

      vi.advanceTimersByTime(30 * 1000);

      // Should not have terminated the connection
      expect(mockWebSocket.closed).toBe(false);
    });
  });

  describe('Utility Methods', () => {
    it('sends raw messages to clients', () => {
      clientManager.sendRawToClient(mockWebSocket as any, 'TEST MESSAGE');
      expect(mockWebSocket.sentMessages).toContain('TEST MESSAGE');
    });

    it('does not send messages to closed connections', () => {
      mockWebSocket.close();

      // Should not throw or send to closed connection
      const result = clientManager.sendRawToClient(mockWebSocket as any, 'TEST MESSAGE');
      expect(result).toBe(false);
      expect(mockWebSocket.sentMessages).not.toContain('TEST MESSAGE');
    });

    it('returns true (drained) when bufferedAmount is low', () => {
      (mockWebSocket as any).bufferedAmount = 0;
      const result = clientManager.sendRawToClient(mockWebSocket as any, 'TEST MESSAGE');
      expect(result).toBe(true);
    });

    it('returns false (backpressure) when bufferedAmount exceeds 1 MiB', () => {
      (mockWebSocket as any).bufferedAmount = 2 * 1024 * 1024;
      const result = clientManager.sendRawToClient(mockWebSocket as any, 'TEST MESSAGE');
      expect(result).toBe(false);
      // Message was still sent — it's a backpressure signal, not a drop
      expect(mockWebSocket.sentMessages).toContain('TEST MESSAGE');
    });

    it('catches ws.send() exceptions and returns false', () => {
      const throwingWs = new MockWebSocket();
      throwingWs.send = () => { throw new Error('frame too large'); };
      const result = clientManager.sendRawToClient(throwingWs as any, 'TEST MESSAGE');
      expect(result).toBe(false);
    });
  });
});