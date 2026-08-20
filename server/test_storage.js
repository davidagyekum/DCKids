// Focused storage-path tests. Run with: node test_storage.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dckids-storage-test-'));
const storageModule = path.join(__dirname, 'storage.js');
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

function loadStorage(env) {
    const result = spawnSync(process.execPath, ['-e',
        "const storage = require(process.argv[1]); process.stdout.write(JSON.stringify(storage));",
        storageModule
    ], {
        env: Object.assign({}, process.env, {
            NODE_ENV: 'test',
            RAILWAY_ENVIRONMENT: '',
            RAILWAY_VOLUME_MOUNT_PATH: '',
            DB_PATH: '',
            UPLOAD_DIR: '',
            BACKUP_DIR: ''
        }, env),
        encoding: 'utf8'
    });
    return result;
}

try {
    const explicitDb = path.join(tempRoot, 'local', 'catalog.db');
    const explicitUploads = path.join(tempRoot, 'local', 'uploads');
    const explicitBackups = path.join(tempRoot, 'local', 'backups');
    const local = loadStorage({ DB_PATH: explicitDb, UPLOAD_DIR: explicitUploads, BACKUP_DIR: explicitBackups });
    check('preserves explicit local durable paths and creates their directories', () => {
        assert.strictEqual(local.status, 0, local.stderr);
        const storage = JSON.parse(local.stdout);
        assert.strictEqual(storage.DB_PATH, explicitDb);
        assert.strictEqual(storage.UPLOAD_DIR, explicitUploads);
        assert.strictEqual(storage.BACKUP_DIR, explicitBackups);
        [path.dirname(explicitDb), explicitUploads, explicitBackups].forEach((directory) => assert.ok(fs.existsSync(directory), directory));
    });

    const ignoredLocalVolume = loadStorage({ RAILWAY_VOLUME_MOUNT_PATH: path.join(tempRoot, 'not-railway') });
    check('does not treat a Railway mount setting as durable storage outside Railway production', () => {
        assert.strictEqual(ignoredLocalVolume.status, 0, ignoredLocalVolume.stderr);
        const storage = JSON.parse(ignoredLocalVolume.stdout);
        assert.strictEqual(storage.DB_PATH, path.join(__dirname, 'inventory.db'));
        assert.strictEqual(storage.UPLOAD_DIR, path.join(__dirname, '..', 'images'));
        assert.strictEqual(storage.BACKUP_DIR, path.join(__dirname, 'backups'));
    });

    const volume = path.join(tempRoot, 'railway-volume');
    const railway = loadStorage({ NODE_ENV: 'production', RAILWAY_ENVIRONMENT: 'production', RAILWAY_VOLUME_MOUNT_PATH: volume });
    check('derives database uploads and backups beneath the Railway volume', () => {
        assert.strictEqual(railway.status, 0, railway.stderr);
        const storage = JSON.parse(railway.stdout);
        assert.strictEqual(storage.DB_PATH, path.join(volume, 'inventory.db'));
        assert.strictEqual(storage.UPLOAD_DIR, path.join(volume, 'uploads'));
        assert.strictEqual(storage.BACKUP_DIR, path.join(volume, 'backups'));
    });

    const missingVolume = loadStorage({ NODE_ENV: 'production', RAILWAY_ENVIRONMENT: 'production' });
    check('rejects Railway production without a mounted volume', () => {
        assert.notStrictEqual(missingVolume.status, 0);
        assert.match(missingVolume.stderr, /RAILWAY_VOLUME_MOUNT_PATH/i);
    });

    const outsideVolume = loadStorage({
        NODE_ENV: 'production',
        RAILWAY_ENVIRONMENT: 'production',
        RAILWAY_VOLUME_MOUNT_PATH: volume,
        UPLOAD_DIR: path.join(tempRoot, 'outside-uploads')
    });
    check('rejects Railway durable paths outside its mounted volume', () => {
        assert.notStrictEqual(outsideVolume.status, 0);
        assert.match(outsideVolume.stderr, /outside.*mounted volume/i);
    });

    console.log(`\n${passed} passed, 0 failed`);
} finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
