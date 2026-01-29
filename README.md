Usage

```bash
 npm install
 npm start
```

# Or with config via env vars:

```bash
 GATEWAY_PORT=8667 \
 GATEWAY_PATH=/irc \
 GATEWAY_WEBIRC_PASSWORD=secret \
 GATEWAY_LOG_LEVEL=debug \

 npm start
```

Programmatic Usage

```typescript
import { startGateway } from "./src/main.js";

const gateway = await startGateway({
  port: 8667,
  path: "/irc",
  webirc: {
    enabled: true,
    password: "your-webirc-password",
    gateway: "my-gateway",
  },
  upstream: {
    allowAnyServer: false,
    allowedServers: [{ host: "irc.libera.chat", port: 6697, tls: true }],
  },
});
```
