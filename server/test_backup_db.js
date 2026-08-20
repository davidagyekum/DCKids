// Focused behavioral tests for the WAL-safe backup command.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dckids-backup-test-'));
const sourcePath = path.join(tempRoot, 'configured-data', 'catalog.db');
const backupDir = path.join(tempRoot, 'configured-backups');
const backupScript = path.join(__dirname, 'backup_db.js');
let passed = 0;

function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (error) {
        console.error(`  FAIL  ${name} — ${error.message}`);
        throw error;
    }
}

function run(sqlite, sql, params = []) {
    return new Promise((resolve, reject) => sqlite.run(sql, params, (error) => error ? reject(error) : resolve()));
}

function get(sqlite, sql) {
    return new Promise((resolve, reject) => sqlite.get(sql, (error, row) => error ? reject(error) : resolve(row)));
}

function close(sqlite) {
    return new Promise((resolve, reject) => sqlite.close((error) => error ? reject(error) : resolve()));
}

function runBackup(dbPath) {
    return spawnSync(process.execPath, [backupScript], {
        env: Object.assign({}, process.env, {
            NODE_ENV: 'test',
            RAILWAY_ENVIRONMENT: '',
            RAILWAY_PROJECT_ID: '',
            RAILWAY_SERVICE_ID: '',
            RAILWAY_VOLUME_MOUNT_PATH: '',
            DB_PATH: dbPath,
            BACKUP_DIR: backupDir,
            UPLOAD_DIR: path.join(tempRoot, 'uploads')
        }),
        encoding: 'utf8'
    });
}

async function runTests() {
    try {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.mkdirSync(backupDir, { recursive: true });
        const source = new sqlite3.Database(sourcePath);
        await run(source, 'PRAGMA journal_mode = WAL');
        await run(source, 'CREATE TABLE orders (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
        await run(source, 'INSERT INTO orders (label) VALUES (?)', ['committed while WAL is enabled']);
        await close(source);

        for (let index = 0; index < 30; index++) {
            const oldFile = path.join(backupDir, `inventory_2000-01-01_00-00-${String(index).padStart(2, '0')}.db`);
            fs.writeFileSync(oldFile, 'old snapshot marker');
            const modified = new Date(946684800000 + index * 1000);
            fs.utimesSync(oldFile, modified, modified);
        }

        const result = runBackup(sourcePath);
        check('backup uses configured database and backup paths', () => {
            assert.strictEqual(result.status, 0, result.stderr);
            assert.match(result.stdout, new RegExp(backupDir.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')));
        });
        check('backup validates the produced SQLite snapshot before success', () => {
            assert.match(result.stdout, /Integrity check passed/i);
        });

        const snapshots = fs.readdirSync(backupDir).filter((file) => /^inventory_.*\.db$/.test(file));
        const produced = snapshots.find((file) => !file.startsWith('inventory_2000-'));
        check('backup retains the 30 newest snapshots', () => {
            assert.strictEqual(snapshots.length, 30);
            assert.ok(produced, `snapshots: ${snapshots.join(', ')}`);
            assert.ok(!fs.existsSync(path.join(backupDir, 'inventory_2000-01-01_00-00-00.db')));
        });

        const snapshotDb = new sqlite3.Database(path.join(backupDir, produced), sqlite3.OPEN_READONLY);
        const integrity = await get(snapshotDb, 'PRAGMA integrity_check');
        const copiedOrder = await get(snapshotDb, 'SELECT label FROM orders WHERE id = 1');
        await close(snapshotDb);
        check('backup snapshot is self-contained and has committed WAL data', () => {
            assert.strictEqual(integrity.integrity_check, 'ok');
            assert.strictEqual(copiedOrder.label, 'committed while WAL is enabled');
        });

        const missing = runBackup(path.join(tempRoot, 'missing.db'));
        check('backup fails nonzero when its configured database is missing', () => {
            assert.notStrictEqual(missing.status, 0);
            assert.match(missing.stderr, /not found/i);
        });

        const corruptPath = path.join(tempRoot, 'corrupt.db');
        fs.writeFileSync(corruptPath, 'this is not sqlite');
        const corrupt = runBackup(corruptPath);
        check('backup fails nonzero when its configured database is corrupt', () => {
            assert.notStrictEqual(corrupt.status, 0);
        });

        console.log(`\n${passed} passed, 0 failed`);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

runTests().catch((error) => {
    console.error('FATAL:', error);
    process.exit(1);
});
