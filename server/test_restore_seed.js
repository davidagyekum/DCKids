const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { restoreCutoverSeed } = require('./restore_seed');

function createDatabase(filePath, productName) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filePath, (openError) => {
            if (openError) return reject(openError);
            db.serialize(() => {
                db.run('CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
                db.run('CREATE TABLE orders (id INTEGER PRIMARY KEY)');
                db.run('CREATE TABLE payments (id INTEGER PRIMARY KEY)');
                db.run('INSERT INTO products (id, name) VALUES (1, ?)', [productName]);
                db.close((closeError) => closeError ? reject(closeError) : resolve());
            });
        });
    });
}

function readProductName(filePath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (openError) => {
            if (openError) return reject(openError);
            db.get('SELECT name FROM products WHERE id = 1', (readError, row) => {
                db.close();
                if (readError) reject(readError);
                else resolve(row && row.name);
            });
        });
    });
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dckids-restore-seed-'));
    const dbPath = path.join(root, 'inventory.db');
    const seedPath = path.join(root, 'cutover-seed.db');
    const backupDir = path.join(root, 'backups');

    try {
        await createDatabase(dbPath, 'Current database');
        const original = fs.readFileSync(dbPath);
        fs.writeFileSync(seedPath, 'not a sqlite database');

        await assert.rejects(
            restoreCutoverSeed({ dbPath, seedPath, backupDir, sqlite3 }),
            /integrity|database/i
        );
        assert.deepStrictEqual(fs.readFileSync(dbPath), original, 'invalid seed must not alter the current database');
        assert.ok(fs.existsSync(seedPath), 'invalid seed must remain available for investigation');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    const restoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dckids-restore-seed-'));
    const restoreDbPath = path.join(restoreRoot, 'inventory.db');
    const restoreSeedPath = path.join(restoreRoot, 'cutover-seed.db');
    const restoreBackupDir = path.join(restoreRoot, 'backups');
    try {
        await createDatabase(restoreDbPath, 'Current database');
        await createDatabase(restoreSeedPath, 'Restored database');
        fs.writeFileSync(restoreDbPath + '-wal', 'stale wal');
        fs.writeFileSync(restoreDbPath + '-shm', 'stale shm');

        const result = await restoreCutoverSeed({
            dbPath: restoreDbPath,
            seedPath: restoreSeedPath,
            backupDir: restoreBackupDir,
            sqlite3
        });

        assert.deepStrictEqual(result, { restored: true });
        assert.strictEqual(await readProductName(restoreDbPath), 'Restored database');
        assert.ok(!fs.existsSync(restoreSeedPath), 'consumed seed must not run again');
        assert.ok(!fs.existsSync(restoreDbPath + '-wal'), 'stale WAL must not accompany the restored database');
        assert.ok(!fs.existsSync(restoreDbPath + '-shm'), 'stale SHM must not accompany the restored database');
        const backups = fs.readdirSync(restoreBackupDir).filter((name) => /^pre_cutover_.*\.db$/.test(name));
        assert.strictEqual(backups.length, 1, 'current database must be retained before replacement');
        assert.strictEqual(await readProductName(path.join(restoreBackupDir, backups[0])), 'Current database');
    } finally {
        fs.rmSync(restoreRoot, { recursive: true, force: true });
    }

    const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dckids-restore-seed-cli-'));
    const cliDbPath = path.join(cliRoot, 'inventory.db');
    const cliSeedPath = path.join(cliRoot, 'cutover-seed.db');
    try {
        await createDatabase(cliDbPath, 'Current database');
        await createDatabase(cliSeedPath, 'Restored by pre-deploy');
        const run = spawnSync(process.execPath, [path.join(__dirname, 'restore_seed.js')], {
            encoding: 'utf8',
            env: Object.assign({}, process.env, {
                NODE_ENV: 'production',
                RAILWAY_ENVIRONMENT: 'production',
                RAILWAY_VOLUME_MOUNT_PATH: cliRoot,
                RAILWAY_VOLUME_NAME: 'test-volume',
                DB_PATH: cliDbPath,
                UPLOAD_DIR: path.join(cliRoot, 'uploads'),
                BACKUP_DIR: path.join(cliRoot, 'backups')
            })
        });
        assert.strictEqual(run.status, 0, run.stderr || run.stdout);
        assert.match(run.stdout, /restored/i);
        assert.strictEqual(await readProductName(cliDbPath), 'Restored by pre-deploy');
    } finally {
        fs.rmSync(cliRoot, { recursive: true, force: true });
    }

    const startupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dckids-startup-seed-'));
    const startupDbPath = path.join(startupRoot, 'inventory.db');
    const startupSeedPath = path.join(startupRoot, 'cutover-seed.db');
    try {
        await createDatabase(startupDbPath, 'Current database');
        await createDatabase(startupSeedPath, 'Restored before startup');
        const run = spawnSync(process.execPath, [path.join(__dirname, 'start_server.js')], {
            encoding: 'utf8',
            env: Object.assign({}, process.env, {
                NODE_ENV: 'production',
                RAILWAY_ENVIRONMENT: 'production',
                RAILWAY_VOLUME_MOUNT_PATH: startupRoot,
                DB_PATH: startupDbPath,
                UPLOAD_DIR: path.join(startupRoot, 'uploads'),
                BACKUP_DIR: path.join(startupRoot, 'backups'),
                JWT_SECRET: ''
            })
        });
        assert.notStrictEqual(run.status, 0, 'server must still enforce its production secret checks');
        assert.match(run.stderr, /JWT_SECRET/);
        assert.strictEqual(await readProductName(startupDbPath), 'Restored before startup');
        assert.ok(!fs.existsSync(startupSeedPath), 'startup must consume the seed before opening the app database');
    } finally {
        fs.rmSync(startupRoot, { recursive: true, force: true });
    }

    console.log('4 passed, 0 failed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
