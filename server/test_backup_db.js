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

function runBackup(dbPath, options = {}) {
    const scriptPath = options.scriptPath || backupScript;
    const destination = Object.prototype.hasOwnProperty.call(options, 'backupDir') ? options.backupDir : backupDir;
    const environment = Object.assign({}, process.env, {
        NODE_ENV: 'test',
        RAILWAY_ENVIRONMENT: '',
        RAILWAY_PROJECT_ID: '',
        RAILWAY_SERVICE_ID: '',
        RAILWAY_VOLUME_MOUNT_PATH: '',
        RAILWAY_VOLUME_NAME: '',
        DB_PATH: dbPath,
        BACKUP_DIR: destination,
        UPLOAD_DIR: path.join(tempRoot, 'uploads')
    }, options.environment);
    if (dbPath === null) delete environment.DB_PATH;
    if (destination === null) delete environment.BACKUP_DIR;
    Object.entries(options.environment || {}).forEach(([name, value]) => {
        if (value === null) delete environment[name];
    });
    return spawnSync(process.execPath, [scriptPath], {
        env: environment,
        encoding: 'utf8'
    });
}

function dotenvPath(filePath) {
    return filePath.replace(/\\/g, '/');
}

async function runTests() {
    let source;
    try {
        const dotenvRoot = path.join(tempRoot, 'dotenv-cli');
        const dotenvDbPath = path.join(dotenvRoot, 'configured-data', 'inventory.db');
        const dotenvBackupDir = path.join(dotenvRoot, 'configured-backups');
        const copiedBackupScript = path.join(dotenvRoot, 'backup_db.js');
        fs.mkdirSync(path.dirname(dotenvDbPath), { recursive: true });
        fs.mkdirSync(dotenvBackupDir, { recursive: true });
        fs.copyFileSync(backupScript, copiedBackupScript);
        fs.copyFileSync(path.join(__dirname, 'storage.js'), path.join(dotenvRoot, 'storage.js'));
        fs.writeFileSync(path.join(dotenvRoot, '.env'), [
            `DB_PATH=${dotenvPath(dotenvDbPath)}`,
            `BACKUP_DIR=${dotenvPath(dotenvBackupDir)}`,
            `UPLOAD_DIR=${dotenvPath(path.join(dotenvRoot, 'uploads'))}`,
            ''
        ].join('\n'));
        const dotenvSource = new sqlite3.Database(dotenvDbPath);
        await run(dotenvSource, 'CREATE TABLE source_marker (label TEXT NOT NULL)');
        await run(dotenvSource, 'INSERT INTO source_marker (label) VALUES (?)', ['dotenv-configured']);
        await close(dotenvSource);

        const dotenvResult = runBackup(null, {
            scriptPath: copiedBackupScript,
            backupDir: null,
            environment: {
                DB_PATH: null,
                BACKUP_DIR: null,
                UPLOAD_DIR: null,
                NODE_PATH: path.join(__dirname, 'node_modules')
            }
        });
        check('backup loads configured paths from its adjacent .env', () => {
            assert.strictEqual(dotenvResult.status, 0, dotenvResult.stderr);
            assert.strictEqual(fs.readdirSync(dotenvBackupDir).filter((file) => file.endsWith('.db')).length, 1);
        });

        const processDbPath = path.join(dotenvRoot, 'process-data', 'inventory.db');
        const processBackupDir = path.join(dotenvRoot, 'process-backups');
        fs.mkdirSync(path.dirname(processDbPath), { recursive: true });
        const processSource = new sqlite3.Database(processDbPath);
        await run(processSource, 'CREATE TABLE source_marker (label TEXT NOT NULL)');
        await run(processSource, 'INSERT INTO source_marker (label) VALUES (?)', ['process-configured']);
        await close(processSource);
        const precedenceResult = runBackup(processDbPath, {
            scriptPath: copiedBackupScript,
            backupDir: processBackupDir,
            environment: {
                UPLOAD_DIR: path.join(dotenvRoot, 'process-uploads'),
                NODE_PATH: path.join(__dirname, 'node_modules')
            }
        });
        const precedenceSnapshot = fs.readdirSync(processBackupDir).find((file) => file.endsWith('.db'));
        const precedenceDb = new sqlite3.Database(path.join(processBackupDir, precedenceSnapshot), sqlite3.OPEN_READONLY);
        const precedenceMarker = await get(precedenceDb, 'SELECT label FROM source_marker');
        await close(precedenceDb);
        check('process environment paths take precedence over backup .env paths', () => {
            assert.strictEqual(precedenceResult.status, 0, precedenceResult.stderr);
            assert.strictEqual(precedenceMarker.label, 'process-configured');
            assert.strictEqual(fs.readdirSync(dotenvBackupDir).filter((file) => file.endsWith('.db')).length, 1);
        });

        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.mkdirSync(backupDir, { recursive: true });
        source = new sqlite3.Database(sourcePath);
        await run(source, 'PRAGMA journal_mode = WAL');
        await run(source, 'PRAGMA wal_autocheckpoint = 0');
        await run(source, 'CREATE TABLE orders (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
        await run(source, 'INSERT INTO orders (label) VALUES (?)', ['committed while WAL is enabled']);
        check('backup fixture keeps committed data resident in WAL with its writer open', () => {
            const walPath = `${sourcePath}-wal`;
            assert.ok(fs.existsSync(walPath), 'open WAL writer must have a WAL sidecar');
            assert.ok(fs.statSync(walPath).size > 32, 'WAL sidecar must contain committed frames');
        });

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
        await close(source);
        source = null;

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
        if (source) {
            try { await close(source); } catch (error) { /* test cleanup only */ }
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

runTests().catch((error) => {
    console.error('FATAL:', error);
    process.exit(1);
});
