const assert = require('assert');
const http = require('http');
const express = require('express');
const { createMaintenanceMiddleware } = require('./maintenance');

function request(server, method, requestPath) {
    const address = server.address();
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: address.port,
            method,
            path: requestPath,
            headers: { 'content-type': 'application/json' }
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({
                status: res.statusCode,
                retryAfter: res.headers['retry-after'],
                body: body ? JSON.parse(body) : null
            }));
        });
        req.on('error', reject);
        if (method === 'POST') req.write('{}');
        req.end();
    });
}

async function main() {
    const app = express();
    app.use(express.json());
    app.use(createMaintenanceMiddleware({ enabled: true, retryAfterSeconds: 300 }));
    app.get('/api/products', (req, res) => res.json({ products: [] }));
    app.post('/api/orders', (req, res) => res.status(201).json({ created: true }));

    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const read = await request(server, 'GET', '/api/products');
        assert.strictEqual(read.status, 200, 'maintenance must keep storefront reads available');

        const write = await request(server, 'POST', '/api/orders');
        assert.strictEqual(write.status, 503, 'maintenance must reject commerce writes');
        assert.strictEqual(write.retryAfter, '300');
        assert.deepStrictEqual(write.body, {
            error: 'The store is temporarily unavailable for maintenance. Please try again shortly.',
            code: 'maintenance'
        });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    console.log('1 passed, 0 failed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
