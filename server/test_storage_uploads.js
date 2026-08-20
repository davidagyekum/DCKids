// Verifies that product uploads survive a real server restart and remain
// addressable through the existing public /images URL namespace.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dckids-upload-restart-'));
const dbPath = path.join(tempRoot, 'inventory.db');
const uploadDir = path.join(tempRoot, 'uploads');
const backupDir = path.join(tempRoot, 'backups');
const port = 3057;
const baseUrl = `http://127.0.0.1:${port}`;
const secret = 'storage-upload-test-secret';
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5xkAAAAASUVORK5CYII=';
let child;

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
        RAILWAY_VOLUME_MOUNT_PATH: ''
    });
    child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.testOutput = () => output;
    return child;
}

async function waitForServer() {
    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            const response = await fetch(`${baseUrl}/api/settings`);
            if (response.ok) return;
        } catch (error) { /* server is still starting */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`server did not start: ${child.testOutput()}`);
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

async function run() {
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

    console.log('  PASS  durable upload persists across restart, serves, and remains healthy');
}

run().catch((error) => {
    console.error('  FAIL  durable upload persists across restart, serves, and remains healthy —', error.message);
    process.exitCode = 1;
}).finally(async () => {
    await stopServer();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});
