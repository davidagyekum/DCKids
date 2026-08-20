/* DC Kids — database backup
 *
 * The DB runs in WAL mode, so a plain file copy of inventory.db is UNSAFE while
 * the server is running: recently-committed rows may still live in the
 * inventory.db-wal sidecar and not yet be merged into the main file. A naive
 * copy can capture a stale or torn snapshot.
 *
 * This uses SQLite's online backup API (sqlite3 .backup), which produces a
 * single consistent .db file with the WAL fully merged in — safe even while
 * the server is actively reading and writing. The output is a normal,
 * self-contained SQLite file (no sidecars needed to restore it).
 *
 * Usage:  node server/backup_db.js
 * Restore: stop the server, replace inventory.db with a backup file
 *          (delete any leftover inventory.db-wal / -shm first), restart.
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { DB_PATH: dbFile, BACKUP_DIR: backupDir } = require('./storage');

if (!fs.existsSync(dbFile)) {
  console.error('Database file not found:', dbFile);
  process.exit(1);
}
const timestamp = new Date().toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
const backupFile = path.join(backupDir, `inventory_${timestamp}.db`);

const source = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('Error opening source database:', err.message);
    process.exit(1);
  }
});

// node-sqlite3 exposes the online backup API as db.backup(filename).
// It copies a transactionally-consistent snapshot, WAL included.
source.serialize(() => {
  const backup = source.backup(backupFile);

  backup.step(-1, function stepDone(err) {
    if (err) {
      console.error('Error during backup:', err.message);
      backup.finish(() => source.close());
      process.exit(1);
      return;
    }
    if (backup.remaining > 0) {
      // Large DB still copying — keep stepping.
      return backup.step(-1, stepDone);
    }
    backup.finish((finishErr) => {
      source.close();
      if (finishErr) {
        console.error('Error finalizing backup:', finishErr.message);
        process.exit(1);
      }
      // Prune to the 30 most recent backups so the folder doesn't grow forever.
      try {
        const files = fs.readdirSync(backupDir)
          .filter(f => /^inventory_.*\.db$/.test(f))
          .map(f => ({ f, t: fs.statSync(path.join(backupDir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        files.slice(30).forEach(({ f }) => fs.unlinkSync(path.join(backupDir, f)));
      } catch (e) { /* pruning is best-effort */ }

      const sizeKb = (fs.statSync(backupFile).size / 1024).toFixed(0);
      console.log(`Backed up database (WAL-safe) to ${backupFile} (${sizeKb} KB)`);
    });
  });
});
