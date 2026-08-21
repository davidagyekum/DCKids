const fs = require('fs');
const path = require('path');

function inspectSeed(seedPath, sqlite3) {
    return new Promise((resolve, reject) => {
        const source = new sqlite3.Database(seedPath, sqlite3.OPEN_READONLY, (openError) => {
            if (openError) return reject(new Error(`Unable to open cutover seed database: ${openError.message}`));
            source.all('PRAGMA integrity_check', (integrityError, rows) => {
                if (integrityError) {
                    return source.close(() => reject(new Error(`Cutover seed integrity check failed: ${integrityError.message}`)));
                }
                const result = rows && rows[0] && rows[0].integrity_check;
                if (result !== 'ok') {
                    return source.close(() => reject(new Error(`Cutover seed integrity check failed: ${result || 'unknown result'}`)));
                }
                source.all(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('products', 'orders', 'payments')",
                    (schemaError, tables) => {
                        source.close((closeError) => {
                            if (schemaError) return reject(new Error(`Unable to inspect cutover seed schema: ${schemaError.message}`));
                            if (closeError) return reject(new Error(`Unable to close cutover seed database: ${closeError.message}`));
                            const names = new Set((tables || []).map((table) => table.name));
                            const missing = ['products', 'orders', 'payments'].filter((name) => !names.has(name));
                            if (missing.length) return reject(new Error(`Cutover seed database is missing required tables: ${missing.join(', ')}`));
                            resolve();
                        });
                    }
                );
            });
        });
    });
}

async function restoreCutoverSeed({ dbPath, seedPath, backupDir, sqlite3 }) {
    if (!fs.existsSync(seedPath)) return { restored: false };
    const resolvedDatabase = path.resolve(dbPath);
    const resolvedSeed = path.resolve(seedPath);
    if (path.dirname(resolvedDatabase) !== path.dirname(resolvedSeed)) {
        throw new Error('Cutover seed and database must be on the same durable filesystem.');
    }
    const seedStat = fs.lstatSync(resolvedSeed);
    if (!seedStat.isFile() || seedStat.isSymbolicLink() || seedStat.nlink !== 1) {
        throw new Error('Cutover seed must be a regular, unlinked file.');
    }
    await inspectSeed(seedPath, sqlite3);

    fs.mkdirSync(backupDir, { recursive: true });
    if (fs.existsSync(resolvedDatabase)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const previousDatabase = path.join(backupDir, `pre_cutover_${timestamp}.db`);
        fs.copyFileSync(resolvedDatabase, previousDatabase, fs.constants.COPYFILE_EXCL);
    }

    [resolvedDatabase + '-wal', resolvedDatabase + '-shm'].forEach((sidecar) => {
        if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    });
    fs.renameSync(resolvedSeed, resolvedDatabase);
    return { restored: true };
}

module.exports = { restoreCutoverSeed };

if (require.main === module) {
    const sqlite3 = require('sqlite3').verbose();
    const {
        DB_PATH,
        BACKUP_DIR,
        VOLUME_PATH,
        ensureDatabaseReady,
        ensureBackupReady
    } = require('./storage');

    if (!VOLUME_PATH) {
        console.log('No Railway volume is configured; cutover seed restore skipped.');
    } else {
        ensureDatabaseReady();
        ensureBackupReady();
        restoreCutoverSeed({
            dbPath: DB_PATH,
            seedPath: path.join(VOLUME_PATH, 'cutover-seed.db'),
            backupDir: BACKUP_DIR,
            sqlite3
        }).then((result) => {
            console.log(result.restored
                ? `Cutover seed restored to ${DB_PATH}.`
                : 'No cutover seed found; restore skipped.');
        }).catch((error) => {
            console.error(`Cutover seed restore failed: ${error.message}`);
            process.exit(1);
        });
    }
}
