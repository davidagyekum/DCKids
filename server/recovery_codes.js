'use strict';

const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const DEFAULT_RECOVERY_CODE_COUNT = 8;

function runAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (error) {
            if (error) reject(error);
            else resolve(this);
        });
    });
}

function allAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => {
            if (error) reject(error);
            else resolve(rows || []);
        });
    });
}

function getAsync(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => {
            if (error) reject(error);
            else resolve(row || null);
        });
    });
}

function closeAsync(db) {
    return new Promise((resolve, reject) => {
        db.close((error) => error ? reject(error) : resolve());
    });
}

function openTransactionDatabase(sourceDb) {
    const filename = sourceDb && String(sourceDb.filename || '');
    if (!filename || filename === ':memory:') {
        return Promise.reject(new Error('Recovery-code replacement requires a file-backed SQLite database'));
    }
    return new Promise((resolve, reject) => {
        const transactionDb = new sqlite3.Database(filename, sqlite3.OPEN_READWRITE, (error) => {
            if (error) {
                transactionDb.close(() => reject(error));
                return;
            }
            transactionDb.configure('busyTimeout', 5000);
            transactionDb.run('PRAGMA foreign_keys = ON', (pragmaError) => {
                if (pragmaError) {
                    transactionDb.close(() => reject(pragmaError));
                    return;
                }
                resolve(transactionDb);
            });
        });
    });
}

function generateRecoveryPlain() {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    return raw.slice(0, 5) + '-' + raw.slice(5);
}

function normalizeRecoveryCode(value) {
    return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

async function replaceRecoveryCodes({ db, bcrypt, userId, count = DEFAULT_RECOVERY_CODE_COUNT, bcryptRounds = 10 }) {
    const normalizedUserId = Number(userId);
    const normalizedCount = Number(count);
    if (!db || !bcrypt || !Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
        throw new Error('Recovery-code dependencies are missing or invalid');
    }
    if (!Number.isInteger(normalizedCount) || normalizedCount < 1 || normalizedCount > 20) {
        throw new Error('Recovery-code count must be an integer between 1 and 20');
    }

    const codes = [];
    const uniqueCodes = new Set();
    while (codes.length < normalizedCount) {
        const code = generateRecoveryPlain();
        if (!uniqueCodes.has(code)) {
            uniqueCodes.add(code);
            codes.push(code);
        }
    }

    const hashes = [];
    for (const code of codes) hashes.push(await bcrypt.hash(code, bcryptRounds));

    const transactionDb = await openTransactionDatabase(db);
    let transactionOpen = false;
    try {
        await runAsync(transactionDb, 'BEGIN IMMEDIATE');
        transactionOpen = true;
        await runAsync(transactionDb, 'DELETE FROM recovery_codes WHERE user_id = ?', [normalizedUserId]);
        for (const hash of hashes) {
            await runAsync(
                transactionDb,
                'INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)',
                [normalizedUserId, hash]
            );
        }
        await runAsync(transactionDb, 'COMMIT');
        transactionOpen = false;
        return codes;
    } catch (error) {
        if (transactionOpen) {
            try {
                await runAsync(transactionDb, 'ROLLBACK');
            } catch (rollbackError) {
                error.rollbackError = rollbackError;
            }
        }
        throw error;
    } finally {
        await closeAsync(transactionDb);
    }
}

async function consumeRecoveryCode({ db, bcrypt, userId, code }) {
    const normalizedUserId = Number(userId);
    const normalizedCode = normalizeRecoveryCode(code);
    if (!db || !bcrypt || !Number.isInteger(normalizedUserId) || normalizedUserId <= 0 || !normalizedCode) {
        return false;
    }

    const rows = await allAsync(
        db,
        'SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL',
        [normalizedUserId]
    );
    for (const row of rows) {
        if (await bcrypt.compare(normalizedCode, row.code_hash)) {
            const update = await runAsync(
                db,
                "UPDATE recovery_codes SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL",
                [row.id]
            );
            return Number(update && update.changes || 0) === 1;
        }
    }
    return false;
}

async function countUnusedRecoveryCodes({ db, userId }) {
    const normalizedUserId = Number(userId);
    if (!db || !Number.isInteger(normalizedUserId) || normalizedUserId <= 0) return 0;
    const row = await getAsync(
        db,
        'SELECT COUNT(*) AS remaining FROM recovery_codes WHERE user_id = ? AND used_at IS NULL',
        [normalizedUserId]
    );
    return Number(row && row.remaining || 0);
}

module.exports = {
    DEFAULT_RECOVERY_CODE_COUNT,
    generateRecoveryPlain,
    normalizeRecoveryCode,
    replaceRecoveryCodes,
    consumeRecoveryCode,
    countUnusedRecoveryCodes
};
