const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const {
    DB_PATH,
    BACKUP_DIR,
    VOLUME_PATH,
    ensureStorageReady
} = require('./storage');
const { restoreCutoverSeed } = require('./restore_seed');

async function start() {
    ensureStorageReady();
    if (VOLUME_PATH) {
        const result = await restoreCutoverSeed({
            dbPath: DB_PATH,
            seedPath: path.join(VOLUME_PATH, 'cutover-seed.db'),
            backupDir: BACKUP_DIR,
            sqlite3
        });
        if (result.restored) console.log(`Cutover seed restored to ${DB_PATH}.`);
    }

    // server.js installs signal handlers only for an executable entry point;
    // this bootstrap remains the single process and delegates that ownership.
    process.env.DCKIDS_SERVER_ENTRYPOINT = '1';
    require('./server');
}

if (require.main === module) {
    start().catch((error) => {
        console.error(`Server startup failed: ${error.message}`);
        process.exit(1);
    });
}

module.exports = { start };
