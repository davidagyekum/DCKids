'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

let recoveryCodes = null;
try {
    recoveryCodes = require('./recovery_codes');
} catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes('recovery_codes')) throw error;
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (error) {
            if (error) reject(error);
            else resolve(this);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => {
            if (error) reject(error);
            else resolve(rows || []);
        });
    });
}

function close(db) {
    return new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
}

async function makeDatabase() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dckids-recovery-test-'));
    const filename = path.join(directory, 'recovery.db');
    const db = new sqlite3.Database(filename);
    db.configure('busyTimeout', 5000);
    await run(db, `CREATE TABLE recovery_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        code_hash TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    )`);
    return { db, directory };
}

async function withDatabase(test) {
    const fixture = await makeDatabase();
    try {
        await test(fixture.db);
    } finally {
        await close(fixture.db);
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
}

function requireRecoveryModule() {
    assert.ok(recoveryCodes, 'server/recovery_codes.js must implement the recovery-code lifecycle');
    return recoveryCodes;
}

async function testReplacementCommitsEveryHashBeforeReturning() {
    const { replaceRecoveryCodes } = requireRecoveryModule();
    await withDatabase(async (db) => {
        await run(db, 'INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)', [7, await bcrypt.hash('OLD01-OLD01', 4)]);

        const codes = await replaceRecoveryCodes({ db, bcrypt, userId: 7, count: 3, bcryptRounds: 4 });
        const rows = await all(db, 'SELECT code_hash FROM recovery_codes WHERE user_id = ? ORDER BY id', [7]);

        assert.strictEqual(codes.length, 3);
        assert.ok(codes.every((code) => /^[A-F0-9]{5}-[A-F0-9]{5}$/.test(code)));
        assert.strictEqual(rows.length, 3, 'the committed replacement set is immediately visible');
        for (let index = 0; index < codes.length; index++) {
            assert.strictEqual(await bcrypt.compare(codes[index], rows[index].code_hash), true);
        }
    });
}

async function testReplacementRollsBackWhenAnInsertFails() {
    const { replaceRecoveryCodes } = requireRecoveryModule();
    await withDatabase(async (db) => {
        const oldHash = await bcrypt.hash('OLD01-OLD01', 4);
        await run(db, 'INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)', [7, oldHash]);
        await run(db, `CREATE TRIGGER reject_recovery_insert
            BEFORE INSERT ON recovery_codes WHEN NEW.user_id = 7
            BEGIN SELECT RAISE(ABORT, 'forced recovery insert failure'); END`);

        await assert.rejects(
            replaceRecoveryCodes({ db, bcrypt, userId: 7, count: 2, bcryptRounds: 4 }),
            /forced recovery insert failure/
        );
        const rows = await all(db, 'SELECT code_hash FROM recovery_codes WHERE user_id = ?', [7]);
        assert.deepStrictEqual(rows.map((row) => row.code_hash), [oldHash], 'the previous set survives a failed replacement');
    });
}

async function testConcurrentConsumptionSucceedsExactlyOnce() {
    const { consumeRecoveryCode } = requireRecoveryModule();
    await withDatabase(async (db) => {
        await run(db, 'INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)', [7, await bcrypt.hash('ABCDE-12345', 4)]);

        const results = await Promise.all([
            consumeRecoveryCode({ db, bcrypt, userId: 7, code: 'abcde-12345' }),
            consumeRecoveryCode({ db, bcrypt, userId: 7, code: 'ABCDE-12345' })
        ]);

        assert.strictEqual(results.filter(Boolean).length, 1, 'only one concurrent request consumes the code');
        assert.strictEqual(results.filter((result) => !result).length, 1);
    });
}

async function testUnusedCountExcludesConsumedCodes() {
    const { countUnusedRecoveryCodes } = requireRecoveryModule();
    await withDatabase(async (db) => {
        await run(db, 'INSERT INTO recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)', [7, 'unused']);
        await run(db, "INSERT INTO recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, datetime('now'))", [7, 'used']);
        await run(db, 'INSERT INTO recovery_codes (user_id, code_hash, used_at) VALUES (?, ?, NULL)', [8, 'other-user']);

        assert.strictEqual(await countUnusedRecoveryCodes({ db, userId: 7 }), 1);
    });
}

(async () => {
    const tests = [
        testReplacementCommitsEveryHashBeforeReturning,
        testReplacementRollsBackWhenAnInsertFails,
        testConcurrentConsumptionSucceedsExactlyOnce,
        testUnusedCountExcludesConsumedCodes
    ];
    for (const test of tests) {
        await test();
        console.log(`PASS  ${test.name}`);
    }
    console.log(`\n${tests.length} recovery-code lifecycle tests passed`);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
