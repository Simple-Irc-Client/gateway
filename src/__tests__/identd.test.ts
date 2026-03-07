import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IdentdServer } from '../identd.js';
import * as net from 'net';

const TEST_PORT = 11113;

function query(port: number, data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(data);
    });

    let response = '';
    socket.on('data', (chunk) => {
      response += chunk.toString();
    });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
    setTimeout(() => reject(new Error('query timeout')), 3000);
  });
}

describe('IdentdServer', () => {
  let server: IdentdServer;

  beforeEach(async () => {
    server = new IdentdServer(5);
    await server.start(TEST_PORT, '127.0.0.1');
  });

  afterEach(async () => {
    await server.stop();
  });

  it('responds with USERID for a registered entry', async () => {
    // Register: localPort=54321 (our ephemeral port to IRC), remotePort=6697 (IRC server port),
    // remoteHost=127.0.0.1 (the IRC server querying us)
    server.register(54321, 6697, '127.0.0.1', 'testuser');

    // RFC 1413 query: "portOnServer, portOnClient"
    // portOnServer = our localPort (54321), portOnClient = IRC server's port (6697)
    const response = await query(TEST_PORT, '54321, 6697\r\n');

    expect(response).toBe('54321 , 6697 : USERID : UNIX : testuser\r\n');
  });

  it('responds with NO-USER for unregistered entry', async () => {
    const response = await query(TEST_PORT, '12345, 6697\r\n');

    expect(response).toContain('ERROR : NO-USER');
  });

  it('responds with INVALID-PORT for non-numeric input', async () => {
    const response = await query(TEST_PORT, 'abc, def\r\n');

    expect(response).toContain('ERROR : INVALID-PORT');
  });

  it('responds with INVALID-PORT for out-of-range ports', async () => {
    const response = await query(TEST_PORT, '0, 99999\r\n');

    expect(response).toContain('ERROR : INVALID-PORT');
  });

  it('responds with INVALID-PORT for malformed query (missing comma)', async () => {
    const response = await query(TEST_PORT, '6697\r\n');

    expect(response).toContain('ERROR : INVALID-PORT');
  });

  it('unregisters entries', async () => {
    server.register(54321, 6697, '127.0.0.1', 'testuser');
    server.unregister(54321, 6697, '127.0.0.1');

    const response = await query(TEST_PORT, '54321, 6697\r\n');

    expect(response).toContain('ERROR : NO-USER');
  });

  it('sanitizes usernames (strips colons, spaces, non-ASCII)', async () => {
    server.register(54321, 6697, '127.0.0.1', 'test:user name\u00ff');

    const response = await query(TEST_PORT, '54321, 6697\r\n');

    expect(response).toContain('USERID : UNIX : test_user_name');
    // Non-ASCII should be stripped
    expect(response).not.toContain('\u00ff');
  });

  it('truncates usernames to 64 characters', async () => {
    const longName = 'a'.repeat(100);
    server.register(54321, 6697, '127.0.0.1', longName);

    const response = await query(TEST_PORT, '54321, 6697\r\n');

    expect(response).toContain('USERID : UNIX : ' + 'a'.repeat(64));
    expect(response).not.toContain('a'.repeat(65));
  });

  it('handles multiple concurrent queries', async () => {
    server.register(11111, 6697, '127.0.0.1', 'user1');
    server.register(22222, 6697, '127.0.0.1', 'user2');

    const [r1, r2] = await Promise.all([
      query(TEST_PORT, '11111, 6697\r\n'),
      query(TEST_PORT, '22222, 6697\r\n'),
    ]);

    expect(r1).toContain('user1');
    expect(r2).toContain('user2');
  });

  it('isolates entries by remote host', async () => {
    // Same ports but different remote hosts
    server.register(54321, 6697, '10.0.0.1', 'userA');
    server.register(54321, 6697, '127.0.0.1', 'userB');

    // Query comes from 127.0.0.1, should get userB
    const response = await query(TEST_PORT, '54321, 6697\r\n');

    expect(response).toContain('userB');
  });

  it('handles query without trailing CRLF (just LF)', async () => {
    server.register(54321, 6697, '127.0.0.1', 'testuser');

    const response = await query(TEST_PORT, '54321, 6697\n');

    expect(response).toContain('USERID : UNIX : testuser');
  });

  it('closes connection after responding', async () => {
    server.register(54321, 6697, '127.0.0.1', 'testuser');

    const ended = await new Promise<boolean>((resolve, reject) => {
      const socket = net.connect({ port: TEST_PORT, host: '127.0.0.1' }, () => {
        socket.write('54321, 6697\r\n');
      });

      // Must consume data for 'end' to fire on readable streams
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      socket.on('data', () => {});
      socket.on('end', () => resolve(true));
      socket.on('error', reject);
      setTimeout(() => resolve(false), 2000);
    });

    expect(ended).toBe(true);
  });

  it('stops and clears entries', async () => {
    server.register(54321, 6697, '127.0.0.1', 'testuser');
    await server.stop();

    // Server should be stopped — connection should fail
    await expect(query(TEST_PORT, '54321, 6697\r\n')).rejects.toThrow();
  });

  it('retries lookup after 500ms on miss (race condition mitigation)', async () => {
    // Don't register yet — let the first lookup miss
    const responsePromise = query(TEST_PORT, '54321, 6697\r\n');

    // Register after a short delay (within the 500ms retry window)
    setTimeout(() => {
      server.register(54321, 6697, '127.0.0.1', 'lateuser');
    }, 200);

    const response = await responsePromise;

    expect(response).toContain('USERID : UNIX : lateuser');
  });

  it('never returns USERID for a different remote host (IP-scoped lookup)', async () => {
    // Register entry for a different host than the one querying (127.0.0.1)
    server.register(54321, 6697, '10.0.0.1', 'secretuser');

    const response = await query(TEST_PORT, '54321, 6697\r\n');

    expect(response).toContain('ERROR : NO-USER');
    expect(response).not.toContain('secretuser');
  });

  it('rejects connections over the concurrency limit', async () => {
    // Register an entry so queries work
    server.register(54321, 6697, '127.0.0.1', 'testuser');

    // Open many connections without sending data to hold them open
    const sockets: net.Socket[] = [];
    for (let i = 0; i < 50; i++) {
      const socket = net.connect({ port: TEST_PORT, host: '127.0.0.1' });
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      socket.on('error', () => {});
      sockets.push(socket);
    }

    // Wait for connections to establish
    await new Promise((r) => setTimeout(r, 100));

    // The 51st connection should be rejected (destroyed without response)
    const rejected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port: TEST_PORT, host: '127.0.0.1' }, () => {
        socket.write('54321, 6697\r\n');
      });
      socket.on('data', () => resolve(false));
      socket.on('close', () => resolve(true));
      socket.on('error', () => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });

    // Clean up held sockets
    for (const s of sockets) s.destroy();

    expect(rejected).toBe(true);
  });
});
