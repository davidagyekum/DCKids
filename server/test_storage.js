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

function loadStorage(env, initialize = false) {
    const result = spawnSync(process.execPath, ['-e',
        "const storage = require(process.argv[1]); if (process.argv[2] === 'ready') storage.ensureStorageReady(); process.stdout.write(JSON.stringify(storage));",
        storageModule,
        initialize ? 'ready' : 'resolve-only'
    ], {
        env: Object.assign({}, process.env, {
            NODE_ENV: 'test',
            RAILWAY_ENVIRONMENT: '',
            RAILWAY_VOLUME_MOUNT_PATH: '',
            RAILWAY_VOLUME_NAME: '',
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
    check('resolves explicit local durable paths without creating directories on import', () => {
        assert.strictEqual(local.status, 0, local.stderr);
        const storage = JSON.parse(local.stdout);
        assert.strictEqual(storage.DB_PATH, explicitDb);
        assert.strictEqual(storage.UPLOAD_DIR, explicitUploads);
        assert.strictEqual(storage.BACKUP_DIR, explicitBackups);
        [path.dirname(explicitDb), explicitUploads, explicitBackups].forEach((directory) => assert.ok(!fs.existsSync(directory), directory));
    });

    const initialized = loadStorage({ DB_PATH: explicitDb, UPLOAD_DIR: explicitUploads, BACKUP_DIR: explicitBackups }, true);
    check('explicit storage readiness creates every configured durable directory', () => {
        assert.strictEqual(initialized.status, 0, initialized.stderr);
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
    const railway = loadStorage({
        NODE_ENV: 'production',
        RAILWAY_ENVIRONMENT: 'production',
        RAILWAY_VOLUME_MOUNT_PATH: volume
    });
    check('derives durable paths from Railway official mount variable alone', () => {
        assert.strictEqual(railway.status, 0, railway.stderr);
        const storage = JSON.parse(railway.stdout);
        assert.strictEqual(storage.DB_PATH, path.join(volume, 'inventory.db'));
        assert.strictEqual(storage.UPLOAD_DIR, path.join(volume, 'uploads'));
        assert.strictEqual(storage.BACKUP_DIR, path.join(volume, 'backups'));
    });

    const missingVolumePath = loadStorage({
        NODE_ENV: 'production',
        RAILWAY_ENVIRONMENT: 'production',
        RAILWAY_VOLUME_NAME: 'dckids-data'
    });
    check('rejects Railway production without the injected volume mount path', () => {
        assert.notStrictEqual(missingVolumePath.status, 0);
        assert.match(missingVolumePath.stderr, /RAILWAY_VOLUME_MOUNT_PATH/i);
    });

    [
        ['DB_PATH', path.join(tempRoot, 'outside.db')],
        ['UPLOAD_DIR', path.join(tempRoot, 'outside-uploads')],
        ['BACKUP_DIR', path.join(tempRoot, 'outside-backups')]
    ].forEach(([name, outsidePath]) => {
        const outsideVolume = loadStorage({
            NODE_ENV: 'production',
            RAILWAY_ENVIRONMENT: 'production',
            RAILWAY_VOLUME_MOUNT_PATH: volume,
            RAILWAY_VOLUME_NAME: 'dckids-data',
            [name]: outsidePath
        });
        check(`rejects Railway ${name} outside its mounted volume`, () => {
            assert.notStrictEqual(outsideVolume.status, 0);
            assert.match(outsideVolume.stderr, /outside.*mounted volume/i);
        });
    });

    const outsideDirectory = path.join(tempRoot, 'outside-symlink-target');
    const uploadsLink = path.join(volume, 'uploads-link');
    fs.mkdirSync(outsideDirectory, { recursive: true });
    fs.mkdirSync(volume, { recursive: true });
    fs.symlinkSync(outsideDirectory, uploadsLink, 'junction');
    const symlinkEscape = loadStorage({
        NODE_ENV: 'production',
        RAILWAY_ENVIRONMENT: 'production',
        RAILWAY_VOLUME_MOUNT_PATH: volume,
        RAILWAY_VOLUME_NAME: 'dckids-data',
        UPLOAD_DIR: path.join(uploadsLink, 'not-created-yet')
    });
    check('rejects Railway durable paths whose symlink ancestor escapes the mounted volume', () => {
        assert.notStrictEqual(symlinkEscape.status, 0);
        assert.match(symlinkEscape.stderr, /outside.*mounted volume/i);
    });

    const publicUploads = path.join(tempRoot, 'public-path-guards', 'uploads');
    [
        ['DB_PATH equal to UPLOAD_DIR', { DB_PATH: publicUploads, BACKUP_DIR: path.join(tempRoot, 'private-backups') }],
        ['DB_PATH nested beneath UPLOAD_DIR', { DB_PATH: path.join(publicUploads, 'inventory.db'), BACKUP_DIR: path.join(tempRoot, 'private-backups') }],
        ['BACKUP_DIR equal to UPLOAD_DIR', { DB_PATH: path.join(tempRoot, 'private-db', 'inventory.db'), BACKUP_DIR: publicUploads }],
        ['BACKUP_DIR nested beneath UPLOAD_DIR', { DB_PATH: path.join(tempRoot, 'private-db', 'inventory.db'), BACKUP_DIR: path.join(publicUploads, 'backups') }]
    ].forEach(([label, configured]) => {
        const exposedPrivatePath = loadStorage(Object.assign({ UPLOAD_DIR: publicUploads }, configured));
        check(`rejects ${label}`, () => {
            assert.notStrictEqual(exposedPrivatePath.status, 0);
            assert.match(exposedPrivatePath.stderr, /public.*upload|UPLOAD_DIR/i);
        });
    });

    const siblingLayout = loadStorage({
        DB_PATH: path.join(tempRoot, 'safe-layout', 'database', 'inventory.db'),
        UPLOAD_DIR: path.join(tempRoot, 'safe-layout', 'uploads'),
        BACKUP_DIR: path.join(tempRoot, 'safe-layout', 'backups')
    });
    check('allows database uploads and backups in normal sibling locations', () => {
        assert.strictEqual(siblingLayout.status, 0, siblingLayout.stderr);
    });

    console.log(`\n${passed} passed, 0 failed`);
} finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
