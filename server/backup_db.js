/* DC Kids — WAL-safe database backup. */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: false });
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { DB_PATH, BACKUP_DIR, ensureBackupReady } = require('./storage');

// Backups need their destination, but must not create unrelated upload or
// database directories merely by resolving configured storage paths.
ensureBackupReady();

const RETAINED_SNAPSHOTS = 30;

function fail(message, error) {
    console.error(message, error ? error.message : '');
    process.exitCode = 1;
}

function closeDatabase(database, callback) {
    database.close((closeError) => {
        if (closeError) console.error('Error closing database:', closeError.message);
        callback();
    });
}

function pruneSnapshots() {
    const snapshots = fs.readdirSync(BACKUP_DIR)
        .filter((file) => /^inventory_.*\.db$/.test(file))
        .map((file) => ({ file, modifiedAt: fs.statSync(path.join(BACKUP_DIR, file)).mtimeMs }))
        .sort((left, right) => right.modifiedAt - left.modifiedAt || right.file.localeCompare(left.file));
    snapshots.slice(RETAINED_SNAPSHOTS).forEach(({ file }) => fs.unlinkSync(path.join(BACKUP_DIR, file)));
}

function validateSnapshot(snapshotPath, callback) {
    const snapshot = new sqlite3.Database(snapshotPath, sqlite3.OPEN_READONLY, (openError) => {
        if (openError) return callback(openError);
        snapshot.get('PRAGMA integrity_check', (queryError, row) => {
            const integrityError = queryError || !row || row.integrity_check !== 'ok'
                ? (queryError || new Error(`integrity_check returned ${row && row.integrity_check}`))
                : null;
            closeDatabase(snapshot, () => callback(integrityError));
        });
    });
}

if (!fs.existsSync(DB_PATH)) {
    fail(`Database file not found: ${DB_PATH}`);
} else {
    const timestamp = new Date().toISOString().replace(/[T:.]/g, '-').replace('Z', '');
    const backupFile = path.join(BACKUP_DIR, `inventory_${timestamp}.db`);
    const source = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (openError) => {
        if (openError) {
            fail('Error opening source database:', openError);
            return;
        }

        // SQLite's online backup API produces a transactionally consistent,
        // self-contained snapshot even when committed data remains in the WAL.
        const backup = source.backup(backupFile);
        const finishWithError = (message, error) => {
            backup.finish(() => closeDatabase(source, () => fail(message, error)));
        };
        const step = (stepError) => {
            if (stepError) return finishWithError('Error during backup:', stepError);
            if (backup.remaining > 0) return backup.step(-1, step);
            backup.finish((finishError) => {
                if (finishError) return closeDatabase(source, () => fail('Error finalizing backup:', finishError));
                closeDatabase(source, () => validateSnapshot(backupFile, (integrityError) => {
                    if (integrityError) {
                        try { fs.unlinkSync(backupFile); } catch (unlinkError) { /* best-effort cleanup of invalid output */ }
                        return fail('Backup integrity check failed:', integrityError);
                    }
                    try {
                        pruneSnapshots();
                    } catch (pruneError) {
                        return fail('Error pruning old backups:', pruneError);
                    }
                    const sizeKb = (fs.statSync(backupFile).size / 1024).toFixed(0);
                    console.log(`Integrity check passed. Backed up database (WAL-safe) to ${backupFile} (${sizeKb} KB)`);
                }));
            });
        };
        backup.step(-1, step);
    });
}
