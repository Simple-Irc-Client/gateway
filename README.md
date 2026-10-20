# IRC Gateway

[![Build Status](https://github.com/Simple-Irc-Client/gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/Simple-Irc-Client/gateway/actions/workflows/ci.yml)

WebSocket to IRC gateway for Simple IRC Client.

## Local Development

```bash
pnpm install
pnpm start
```

Gateway runs on `ws://localhost:8667/webirc`

## Testing

```bash
pnpm test           # Run tests once
pnpm run test:watch # Run tests in watch mode
pnpm run lint       # TypeScript + ESLint checks
```

## Server Deployment

### Docker / Podman

```bash
docker build -t simple-irc-gateway .

docker run -d \
  --name sic-gateway \
  --restart unless-stopped \
  -p 8667:8667 \
  -p 113:8113 \
  -e PORT=8667 \
  -e HOST=0.0.0.0 \
  -e IDENTD_ENABLED=true \
  -e IDENTD_PORT=8113 \
  simple-irc-gateway
```

The container runs as the non-root `node` user. Identd binds to a high port (8113) inside the container, mapped to host port 113 via `-p 113:8113` — no `CAP_NET_BIND_SERVICE` needed.

### Reverse Proxy (Caddy)

```bash
sudo apt install caddy
```

`/etc/caddy/Caddyfile`:

```
irc.yourdomain.com {
    reverse_proxy /webirc localhost:8667
}
```

```bash
sudo systemctl reload caddy
```

### Reverse Proxy (Nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name irc.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /webirc {
        proxy_pass http://127.0.0.1:8667;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}
```

### Automated Deployment (GitHub Actions)

CI deploys via a non-privileged `deploy` user with scoped `sudo` — it never logs in as
root. Provision the server **once** as root:

```bash
# from a checkout of this repo on the server (or after scp-ing the deploy/ dir)
sudo DEPLOY_PUBKEY="$(cat deploy_key.pub)" bash deploy/bootstrap.sh
```

`bootstrap.sh` creates the `deploy` user, installs its SSH key, installs podman + caddy,
creates `/opt/sic-gateway` (deploy-owned), and writes a scoped `/etc/sudoers.d/sic-deploy`
granting only the binaries deploys need (`systemctl`, `podman`, `nft`, `apt-get`, `tee`,
the firewall script). The private half of `DEPLOY_PUBKEY` is the GitHub Actions `SSH_KEY`
secret. Re-run `bootstrap.sh` (as root) after changing the package set or sudoers scope.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8667 | Server port |
| `HOST` | 0.0.0.0 | Bind address |
| `PATH_PREFIX` | /webirc | WebSocket path |
| `ALLOWED_ORIGINS` | `https://app.simpleircclient.com` | Comma-separated WebSocket `Origin` values; set this to your own frontend's origin |
| `ALLOWED_SERVERS` | - | Comma-separated list (e.g., `irc.libera.chat:6697`); empty allows all |
| `TRUST_PROXY` | false | Read the client IP from `X-Forwarded-For`; enable only behind a reverse proxy |
| `BLOCK_PRIVATE_HOSTS` | true | Set to `false` to allow IRC servers on private or loopback addresses (local testing, LAN servers) |
| `WEBIRC_PASSWORD` | - | WEBIRC password (optional) |
| `WEBIRC_GATEWAY` | gateway | WEBIRC gateway name |
| `PONG_TIMEOUT` | 120 | Seconds to wait for the IRC server's PONG |
| `WS_PING_INTERVAL` | 30 | Seconds between WebSocket keepalive pings |
| `WS_PONG_TIMEOUT` | 120 | Seconds to wait for a WebSocket pong before disconnecting |
| `REGISTRATION_TIMEOUT` | 30 | Seconds for the client to send NICK/USER (0 disables) |
| `SESSION_LINGER` | 1800 | Seconds a resumable session keeps its IRC connection after the browser disconnects (0 disables resuming) |
| `SESSION_BUFFER_SIZE` | 131072 | Bytes of recent IRC lines kept per resumable session for the browser to catch up on |
| `IDENTD_ENABLED` | false | Enable identd (RFC 1413) server |
| `IDENTD_PORT` | 113 | Identd listen port |
| `IDENTD_TIMEOUT` | 30 | Identd connection timeout (seconds) |

## Resumable Sessions

Mobile browsers drop a backgrounded tab's WebSocket within seconds. A client that asks for a resumable session keeps its IRC connection on the gateway, like a small bouncer, so coming back costs no quit, rejoin or lost messages.

| Query parameter | Meaning |
|-----------------|---------|
| `session=true` | Start a resumable session. The gateway's first line is `:sic-gateway SESSION <token>`, and every relayed IRC line is tagged `@simpleircclient.com/seq=<n>`. |
| `resume=<token>&since=<n>` | Reattach to the session. The first line is `:sic-gateway RESUMED complete` (or `partial` when the buffer dropped lines), followed by the lines after `<n>`. Lines without server-time get a `time` tag. An unknown or expired token starts a new session instead: the first line is then `SESSION`. |
| `replace=<token>` | Together with `session=true`: end that session first. Used after a page reload, when the page no longer has the state to resume it. |

- A WebSocket that closes after the client sent `QUIT`, or before the IRC server welcomed it, ends the session as before. Without `session=true` nothing changes.
- A session that is not resumed within `SESSION_LINGER` seconds quits IRC. Closing the tab therefore leaves the user online for up to that long.
- Resuming the session from a second WebSocket closes the first one with code 4001.
- Detached sessions count towards the gateway's client limit (1000) and the per-IP limit (10). When either is reached, the session detached longest ago is ended to make room; sessions with a browser attached are never ended for that.
- Memory: each resumable session buffers at most `SESSION_BUFFER_SIZE` bytes of line text, so 1000 sessions at the default take roughly 128 MB in the worst case (plus per-line overhead). Lower it for small servers.
- Sessions live in the gateway process: a restart or deploy ends them, and clients reconnect from scratch.
- The token is the only credential for a session. It is 128 random bits, is never logged, and only works for the same IRC server, port, TLS setting and encoding.

## Identd (RFC 1413)

IRC servers query port 113 on connecting clients to verify identity. Without identd, users appear with an unverified ident (prefixed with `~`). Enabling the built-in identd server lets the gateway respond with the correct username.

### Enable identd

Set `IDENTD_ENABLED=true` and configure the port. When running in Docker/Podman, use a high port inside the container (e.g. `IDENTD_PORT=8113`) and map it to host port 113 with `-p 113:8113`. This avoids needing any special capabilities.

### Client ident parameter

WebSocket clients can pass a custom ident username via the `ident` query parameter:

```
ws://gateway:8667/webirc?host=irc.example.com&port=6697&tls=true&ident=myuser
```

If not provided, the gateway derives a username from the client's IP address.

## WEBIRC

To forward real client IPs to IRC servers:

1. Request WEBIRC access from the IRC network
2. Set `WEBIRC_PASSWORD` environment variable
3. Behind a reverse proxy, set `TRUST_PROXY=true`, otherwise the proxy's IP is forwarded

## Frontend Configuration

Build `core` in gateway mode with the gateway's address in `core/.env.gateway`:

```bash
VITE_GATEWAY_HOST=irc.yourdomain.com
VITE_GATEWAY_PORT=443
VITE_GATEWAY_PATH=/webirc
```

```bash
pnpm run build:gateway
```
