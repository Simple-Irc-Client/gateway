# IRC Gateway

[![Build Status](https://github.com/Simple-Irc-Client/gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/Simple-Irc-Client/gateway/actions/workflows/ci.yml)

WebSocket to IRC gateway for Simple IRC Client.

## Local Development

```bash
npm install
npm start
```

Gateway runs on `ws://localhost:8667/irc`

## Testing

```bash
npm test           # Run tests once
npm run test:watch # Run tests in watch mode
npm run lint       # TypeScript + ESLint checks
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
    reverse_proxy /irc localhost:8667
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

    location /irc {
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

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8667 | Server port |
| `HOST` | 0.0.0.0 | Bind address |
| `PATH_PREFIX` | /irc | WebSocket path |
| `WEBIRC_PASSWORD` | - | WEBIRC password (optional) |
| `WEBIRC_GATEWAY` | gateway | WEBIRC gateway name |
| `ALLOWED_SERVERS` | - | Comma-separated list (e.g., `irc.libera.chat:6697`) |
| `IDENTD_ENABLED` | false | Enable identd (RFC 1413) server |
| `IDENTD_PORT` | 113 | Identd listen port |
| `IDENTD_TIMEOUT` | 30 | Identd connection timeout (seconds) |

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
3. Gateway sends client IP to IRC server

## Frontend Configuration

Update your frontend to connect to the gateway:

```typescript
const WS_URL = 'wss://irc.yourdomain.com/irc';
```
