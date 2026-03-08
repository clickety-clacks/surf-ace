const http = require('node:http');
const net = require('node:net');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address.port !== 'number') {
          reject(new Error('Unable to allocate free port'));
          return;
        }
        resolve(address.port);
      });
    });
    server.on('error', reject);
  });
}

async function createCallbackCaptureServer({ responseStatus = [200] } = {}) {
  const port = await getFreePort();
  const requests = [];
  let callCount = 0;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const body = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }

    requests.push({
      body,
      headers: req.headers,
      json,
      method: req.method,
      path: req.url,
      timestamp: Date.now()
    });

    const status = responseStatus[Math.min(callCount, responseStatus.length - 1)] ?? 200;
    callCount += 1;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
    },
    getCallCount: () => callCount,
    requests,
    url: `http://127.0.0.1:${port}/events`,
    waitForCount: async (expected, { timeoutMs = 2500 } = {}) => {
      const start = Date.now();
      while (Date.now() - start <= timeoutMs) {
        if (requests.length >= expected) {
          return;
        }
        await delay(10);
      }
      throw new Error(`Timed out waiting for ${expected} callbacks; got ${requests.length}`);
    }
  };
}

module.exports = {
  createCallbackCaptureServer,
  delay,
  getFreePort
};
