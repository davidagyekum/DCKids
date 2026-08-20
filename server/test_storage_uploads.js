// Verifies that product uploads survive a real server restart and remain
// addressable through the existing public /images URL namespace.
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dckids-upload-restart-'));
const dbPath = path.join(tempRoot, 'inventory.db');
const uploadDir = path.join(tempRoot, 'uploads');
const backupDir = path.join(tempRoot, 'backups');
let port;
let baseUrl;
const secret = 'storage-upload-test-secret';
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5xkAAAAASUVORK5CYII=';
const checkedInFallbackFilename = `product_upload_${Date.now()}_${Math.floor(Math.random() * 10000)}.png`;
const checkedInFallbackPath = path.join(__dirname, '..', 'images', checkedInFallbackFilename);
let child;

function requestAvailablePort() {
    return new Promise((resolve, reject) => {
        const reservation = net.createServer();
        reservation.once('error', reject);
        reservation.listen(0, '127.0.0.1', () => {
            const assignedPort = reservation.address().port;
            reservation.close((error) => error ? reject(error) : resolve(assignedPort));
        });
    });
}

function startServer() {
    const environment = Object.assign({}, process.env, {
        PORT: String(port),
        NODE_ENV: 'test',
        DB_PATH: dbPath,
        UPLOAD_DIR: uploadDir,
        BACKUP_DIR: backupDir,
        JWT_SECRET: secret,
        OWNER_EMAIL: 'storage-owner@test.com',
        RESEND_API_KEY: '',
        FIREBASE_PROJECT_ID: '',
        RAILWAY_ENVIRONMENT: '',
        RAILWAY_VOLUME_MOUNT_PATH: '',
        RAILWAY_VOLUME_NAME: ''
    });
    child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.testOutput = () => output;
    return child;
}

async function waitForServer() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`server exited before readiness: ${child.testOutput()}`);
        }
        try {
            const response = await fetch(`${baseUrl}/api/settings`);
            if (response.ok) return;
        } catch (error) { /* server is still starting */ }
        if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`server exited before readiness: ${child.testOutput()}`);
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(100, remainingMs)));
        }
    }
    throw new Error(`server did not become ready within 15000ms: ${child.testOutput()}`);
}

async function stopServer() {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
}

function json(method, body, headers) {
    return {
        method,
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(body)
    };
}

function setProductImage(productId, imagePath) {
    return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(dbPath, (openError) => {
            if (openError) return reject(openError);
            database.run('UPDATE products SET img = ? WHERE id = ?', [imagePath, productId], (runError) => {
                database.close((closeError) => {
                    if (runError) reject(runError);
                    else if (closeError) reject(closeError);
                    else resolve();
                });
            });
        });
    });
}

async function run() {
    port = await requestAvailablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    startServer();
    await waitForServer();
    const registered = await fetch(`${baseUrl}/api/admin/register`, json('POST', {
        full_name: 'Storage Owner', email: 'storage-owner@test.com', phone: '0241111111'
    }));
    assert.strictEqual(registered.status, 201, 'test owner should register');
    const auth = { Authorization: `Bearer ${jwt.sign({ id: 1 }, secret, { expiresIn: '5m' })}` };
    const upload = await fetch(`${baseUrl}/api/upload-image`, json('POST', { dataUrl: tinyPng }, auth));
    const uploaded = await upload.json();
    assert.strictEqual(upload.status, 200, JSON.stringify(uploaded));
    assert.match(uploaded.path, /^images\/product_upload_\d+_\d+\.png$/);
    const filename = path.basename(uploaded.path);
    assert.ok(fs.existsSync(path.join(uploadDir, filename)), 'upload must be written to the configured durable upload directory');

    await stopServer();

    startServer();
    await waitForServer();
    const served = await fetch(`${baseUrl}/${uploaded.path}`);
    const servedBytes = Buffer.from(await served.arrayBuffer());
    assert.strictEqual(served.status, 200, 'durable upload should still be served after restart');
    assert.deepStrictEqual(servedBytes, Buffer.from(tinyPng.split(',')[1], 'base64'));

    const mapped = await fetch(`${baseUrl}/api/products/bulk-images`, json('POST', {
        items: [{ id: 1, img: uploaded.path }]
    }, auth));
    assert.strictEqual(mapped.status, 200, 'durable upload should remain valid for product image mapping');
    const healthResponse = await fetch(`${baseUrl}/api/products/image-health`, { headers: auth });
    const health = await healthResponse.json();
    assert.strictEqual(healthResponse.status, 200);
    assert.ok(!health.invalidPaths.some((entry) => entry.img === uploaded.path), 'image health must find durable uploads');
    assert.ok(!health.unusedUploads.includes(uploaded.path), 'mapped durable upload must not be reported unused');

    fs.writeFileSync(checkedInFallbackPath, Buffer.from(tinyPng.split(',')[1], 'base64'));
    assert.ok(!fs.existsSync(path.join(uploadDir, checkedInFallbackFilename)), 'fallback fixture must not have a durable copy');
    const fallbackServed = await fetch(`${baseUrl}/images/${checkedInFallbackFilename}`);
    assert.strictEqual(fallbackServed.status, 200, 'checked-in uploaded image should be served when durable storage has no copy');
    await setProductImage(2, `images/${checkedInFallbackFilename}`);
    const fallbackHealthResponse = await fetch(`${baseUrl}/api/products/image-health`, { headers: auth });
    const fallbackHealth = await fallbackHealthResponse.json();
    assert.strictEqual(fallbackHealthResponse.status, 200);
    assert.ok(!fallbackHealth.invalidPaths.some((entry) => entry.img === `images/${checkedInFallbackFilename}`),
        'image health must accept a checked-in uploaded image when durable storage has no copy');

    console.log('  PASS  durable and checked-in uploaded images serve and remain healthy');
}

run().catch((error) => {
    console.error('  FAIL  durable upload persists across restart, serves, and remains healthy —', error.message);
    process.exitCode = 1;
}).finally(async () => {
    await stopServer();
    try { fs.unlinkSync(checkedInFallbackPath); } catch (error) { /* fixture was not created */ }
    fs.rmSync(tempRoot, { recursive: true, force: true });
});
