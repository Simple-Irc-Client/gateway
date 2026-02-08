# IRC Gateway

[![Build Status](https://github.com/Simple-Irc-Client/gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/Simple-Irc-Client/gateway/actions/workflows/ci.yml)

WebSocket to IRC gateway for Simple IRC Client.

## Project Structure

```
src/
├── config.ts      # Configuration interface and defaults
├── gateway.ts     # WebSocket server and client management
├── irc-client.ts  # IRC protocol client with encoding support
├── logger.ts      # Colored console logging
├── main.ts        # Entry point
└── __tests__/     # Unit tests
```

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

### 1. Install Node.js 20+

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Clone and Build

```bash
git clone <repo> /opt/irc-gateway
cd /opt/irc-gateway/gateway
npm ci
npm run build
```

### 3. Create Systemd Service

```bash
sudo tee /etc/systemd/system/irc-gateway.service << 'EOF'
[Unit]
Description=IRC Gateway
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/irc-gateway/gateway
ExecStart=/usr/bin/node dist/gateway.js
Restart=always
RestartSec=5
Environment=PORT=8667
Environment=HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
EOF
```

### 4. Start Service

```bash
sudo systemctl daemon-reload
sudo systemctl enable irc-gateway
sudo systemctl start irc-gateway
sudo systemctl status irc-gateway
```

### 5. Reverse Proxy (Caddy)

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

### 6. Reverse Proxy (Nginx)

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
