const http = require('node:http');
const net = require('node:net');

const HTTP_PORT = process.env.PORT || 8667;
const IDENTD_PORT = process.env.IDENTD_PORT || 113;
const TIMEOUT = 5000;

Promise.all([
  new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${HTTP_PORT}`, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 400) {
        res.resume();
        resolve();
      } else {
        reject(new Error(`HTTP ${res.statusCode}`));
      }
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT, () => { req.destroy(); reject(new Error('HTTP timeout')); });
  }),
  new Promise((resolve, reject) => {
    if (process.env.IDENTD_ENABLED !== 'true') return resolve();
    const socket = net.connect(IDENTD_PORT, '127.0.0.1', () => { socket.destroy(); resolve(); });
    socket.on('error', reject);
    socket.setTimeout(TIMEOUT, () => { socket.destroy(); reject(new Error('identd timeout')); });
  }),
]).then(() => process.exit(0))
  .catch((err) => { console.error('healthcheck failed:', err.message); process.exit(1); });
