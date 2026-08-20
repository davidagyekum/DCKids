// Exercises real process signal handling while an open connection keeps the
// HTTP server in its graceful-drain phase.
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dckids-shutdown-test-'));
const testPort = 35000 + Math.floor(Math.random() * 1000);
const signalBridge = path.join(__dirname, 'test_signal_bridge.js');
let child = null;
let socket = null;

function waitForOutput(pattern, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), timeoutMs);
        const check = () => {
            if (pattern.test(child.output)) {
                clearTimeout(timeout);
                resolve();
            }
        };
        child.on('output', check);
        check();
    });
}

function waitForExit(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for the server to exit')), timeoutMs);
        child.once('exit', (code, signal) => {
            clearTimeout(timeout);
            resolve({ code, signal });
        });
    });
}

async function run() {
    try {
        child = fork(path.join(__dirname, 'server.js'), [], {
            cwd: __dirname,
            execArgv: ['--require', signalBridge],
            env: Object.assign({}, process.env, {
                PORT: String(testPort),
                NODE_ENV: 'test',
                DB_PATH: path.join(tempRoot, 'inventory.db'),
                BACKUP_DIR: path.join(tempRoot, 'backups'),
                UPLOAD_DIR: path.join(tempRoot, 'uploads'),
                RAILWAY_ENVIRONMENT: '',
                RAILWAY_PROJECT_ID: '',
                RAILWAY_SERVICE_ID: '',
                RAILWAY_VOLUME_MOUNT_PATH: '',
                RESEND_API_KEY: '',
                FIREBASE_PROJECT_ID: '',
                OWNER_EMAIL: 'shutdown@test.com',
                JWT_SECRET: 'shutdown-test-secret'
            }),
            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        });
        child.output = '';
        child.stdout.on('data', (chunk) => { child.output += chunk.toString(); child.emit('output'); });
        child.stderr.on('data', (chunk) => { child.output += chunk.toString(); child.emit('output'); });

        await waitForOutput(/Server running on port/);
        socket = net.createConnection({ host: '127.0.0.1', port: testPort });
        await new Promise((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
        });
        // Leave this request incomplete so server.close waits in its drain phase.
        socket.write('GET /api/health HTTP/1.1\r\nHost: localhost\r\n');
        await new Promise((resolve) => setTimeout(resolve, 100));

        child.send({ signal: 'SIGTERM' });
        await waitForOutput(/SIGTERM received; draining HTTP requests/);
        assert.strictEqual(child.exitCode, null, 'server should still be draining after the first signal');
        const exitResult = waitForExit();
        child.send({ signal: 'SIGTERM' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        socket.destroy();
        const result = await exitResult;

        assert.strictEqual(result.signal, null, `unexpected signal exit: ${result.signal}`);
        assert.strictEqual(result.code, 0, child.output);
        assert.match(child.output, /SQLite checkpointed and closed cleanly/);
        console.log('PASS  repeated SIGTERM during drain still checkpoints and closes SQLite');
    } finally {
        if (socket && !socket.destroyed) socket.destroy();
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('FAIL  repeated SIGTERM during drain still checkpoints and closes SQLite');
    console.error(error.stack || error);
    process.exit(1);
});
