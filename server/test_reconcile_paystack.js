// Focused behavioral tests for the offline Paystack reconciliation CLI.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dckids-reconcile-test-'));
const cliPath = path.join(__dirname, 'reconcile_paystack.js');
let passed = 0;

async function check(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (error) {
        console.error(`  FAIL  ${name} — ${error.message}`);
        throw error;
    }
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) reject(error);
        else resolve(this);
    }));
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

function close(db) {
    return new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
}

async function openDatabase(dbPath) {
    const db = new sqlite3.Database(dbPath);
    await run(db, 'PRAGMA foreign_keys = ON');
    return db;
}

async function createSchema(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = await openDatabase(dbPath);
    await run(db, `CREATE TABLE products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        stock INTEGER DEFAULT 10
    )`);
    await run(db, `CREATE TABLE customer_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        phone TEXT,
        name TEXT
    )`);
    await run(db, `CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_number TEXT UNIQUE NOT NULL,
        customer_name TEXT,
        customer_phone TEXT,
        order_type TEXT,
        total_amount REAL,
        status TEXT,
        delivery_area TEXT,
        notes TEXT,
        customer_email TEXT,
        delivery_address_line1 TEXT,
        delivery_address_line2 TEXT,
        delivery_city TEXT,
        delivery_region TEXT,
        delivery_landmark TEXT,
        customer_account_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_account_id) REFERENCES customer_accounts (id)
    )`);
    await run(db, `CREATE TABLE order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        product_id INTEGER,
        product_name TEXT,
        quantity INTEGER,
        price_at_time REAL,
        FOREIGN KEY (order_id) REFERENCES orders (id)
    )`);
    await run(db, `CREATE TABLE payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        payment_method TEXT NOT NULL DEFAULT 'Mobile Money',
        amount REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        provider TEXT,
        provider_reference TEXT,
        provider_transaction_id TEXT,
        currency TEXT DEFAULT 'GHS',
        channel TEXT,
        gateway_response TEXT,
        paid_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        owner_notified_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders (id)
    )`);
    await run(db, 'CREATE UNIQUE INDEX idx_payments_provider_reference ON payments (provider_reference)');
    await run(db, 'CREATE UNIQUE INDEX idx_payments_provider_transaction ON payments (provider_transaction_id)');
    return db;
}

function executeCli(dbPath, inputPath, reportPath, extraArgs = [], environment = {}) {
    return spawnSync(process.execPath, [cliPath, '--input', inputPath, '--report', reportPath, ...extraArgs], {
        env: Object.assign({}, process.env, {
            NODE_ENV: 'test',
            RAILWAY_ENVIRONMENT: '',
            RAILWAY_PROJECT_ID: '',
            RAILWAY_SERVICE_ID: '',
            RAILWAY_VOLUME_MOUNT_PATH: '',
            DB_PATH: dbPath,
            BACKUP_DIR: path.join(tempRoot, 'backups'),
            UPLOAD_DIR: path.join(tempRoot, 'uploads')
        }, environment),
        encoding: 'utf8'
    });
}

function successfulTransaction(overrides = {}) {
    return Object.assign({
        id: 7001,
        reference: 'DCK-RECOVER-001',
        status: 'success',
        amount: 12345,
        currency: 'GHS',
        channel: 'mobile_money',
        paid_at: '2026-08-19T04:35:00.000Z',
        customer: {
            email: 'alice@example.com',
            first_name: 'Alice',
            last_name: 'Recovery',
            phone: '+233 24 111 2222'
        },
        metadata: {
            source_app: 'dckids',
            order_number: 'ORD-RECOVERED-001',
            delivery_address: 'Sensitive Street',
            private_note: 'never copy raw metadata'
        },
        authorization: { authorization_code: 'AUTH_secret' },
        gateway_response: 'Approved'
    }, overrides);
}

async function runTests() {
    const dbPath = path.join(tempRoot, 'main', 'inventory.db');
    const inputPath = path.join(tempRoot, 'paystack.json');
    const dryReportPath = path.join(tempRoot, 'dry-report.json');
    const applyReportPath = path.join(tempRoot, 'apply-report.json');
    const replayReportPath = path.join(tempRoot, 'replay-report.json');
    let db = await createSchema(dbPath);
    await run(db, "INSERT INTO products (name, stock) VALUES ('Keep Stock', 17)");
    const account = await run(db, "INSERT INTO customer_accounts (email, name) VALUES ('alice@example.com', 'Account Alice')");
    const existingOrder = await run(db, `INSERT INTO orders
        (order_number, customer_name, total_amount, status) VALUES ('ORD-EXISTING', 'Existing', 50, 'paid')`);
    await run(db, `INSERT INTO payments
        (order_id, payment_method, amount, status, provider, provider_reference, provider_transaction_id, currency)
        VALUES (?, 'Paystack', 50, 'paid', 'paystack', 'DCK-EXISTING-001', '6999', 'GHS')`, [existingOrder.lastID]);
    await run(db, `INSERT INTO orders
        (order_number, customer_name, total_amount, status) VALUES ('ORD-COLLISION', 'Unrelated', 10, 'pending')`);
    await close(db);

    const second = successfulTransaction({
        id: '7002',
        reference: 'DCK-RECOVER-002',
        amount: 8000,
        channel: 'card',
        customer: { email: 'second@example.com', first_name: 'Second', last_name: 'Buyer', phone: '0200000000' },
        metadata: { source_app: 'dckids', order_number: 'ORD-COLLISION' }
    });
    const exportRows = [
        successfulTransaction(),
        second,
        successfulTransaction({ id: 6999, reference: 'DCK-EXISTING-001' }),
        null,
        {},
        successfulTransaction({ id: 7100, reference: 'DCK-FAILED', status: 'failed' }),
        successfulTransaction({ id: 7101, reference: 'DCK-USD', currency: 'USD' }),
        successfulTransaction({ id: 7102, reference: 'OTHER-001' }),
        successfulTransaction({ id: 7103, reference: 'DCK-FOREIGN', metadata: { source_app: 'akua_inventory' } })
    ];
    fs.writeFileSync(inputPath, JSON.stringify(exportRows));

    const dryRun = executeCli(dbPath, inputPath, dryReportPath);
    await check('CLI defaults to dry-run and accepts an array export', () => {
        assert.strictEqual(dryRun.status, 0, dryRun.stderr);
        const report = JSON.parse(fs.readFileSync(dryReportPath, 'utf8'));
        assert.strictEqual(report.mode, 'dry-run');
        assert.strictEqual(report.summary.wouldRestore, 2);
        assert.strictEqual(report.summary.restored, 0);
        assert.strictEqual(report.summary.alreadyPresent, 1);
        assert.strictEqual(report.summary.rejected, 6);
        assert.ok(report.wouldRestore.every((entry) => entry.status === 'would_restore'));
        assert.strictEqual(report.alreadyPresent[0].status, 'already_present');
        assert.ok(report.rejected.every((entry) => entry.status === 'rejected'));
    });
    db = await openDatabase(dbPath);
    await check('dry-run makes no database changes', async () => {
        assert.strictEqual((await get(db, 'SELECT COUNT(*) AS count FROM orders')).count, 2);
        assert.strictEqual((await get(db, 'SELECT COUNT(*) AS count FROM payments')).count, 1);
        assert.strictEqual((await get(db, 'SELECT stock FROM products WHERE id = 1')).stock, 17);
    });
    await close(db);

    const dryReportText = fs.readFileSync(dryReportPath, 'utf8');
    await check('dry-run report masks email and excludes raw PII and gateway data', () => {
        assert.match(dryReportText, /a\*\*\*@example\.com/);
        ['alice@example.com', 'Alice', 'Recovery', '+233 24 111 2222', 'Sensitive Street',
            'never copy raw metadata', 'AUTH_secret', 'gateway_response', 'authorization'].forEach((secret) => {
            assert.ok(!dryReportText.includes(secret), `report leaked ${secret}`);
        });
    });

    fs.writeFileSync(inputPath, JSON.stringify({ data: exportRows }));
    const missingAttestation = executeCli(dbPath, inputPath, applyReportPath, ['--apply']);
    await check('apply requires verified-export and backup attestations', () => {
        assert.notStrictEqual(missingAttestation.status, 0);
        assert.match(missingAttestation.stderr, /verified.*export.*backup/i);
    });

    const applied = executeCli(dbPath, inputPath, applyReportPath, ['--apply', '--verified-export', '--backup-confirmed']);
    await check('apply accepts a data-wrapped export and restores valid missing payments', () => {
        assert.strictEqual(applied.status, 0, applied.stderr);
        const report = JSON.parse(fs.readFileSync(applyReportPath, 'utf8'));
        assert.strictEqual(report.mode, 'apply');
        assert.strictEqual(report.restored.length, 2);
        assert.ok(report.restored.every((entry) => entry.status === 'restored'));
        assert.ok(report.restored.every((entry) => entry.reviewState === 'incomplete_review'));
        assert.strictEqual(report.summary.restored, 2);
        assert.strictEqual(report.summary.incompleteReview, 2);
        assert.strictEqual(report.incompleteReview, undefined);
    });

    db = await openDatabase(dbPath);
    const restoredOrder = await get(db, `SELECT * FROM orders WHERE order_number = 'ORD-RECOVERED-001'`);
    const restoredPayment = await get(db, `SELECT * FROM payments WHERE provider_reference = 'DCK-RECOVER-001'`);
    await check('restore preserves transaction and customer identity in payment-review state', () => {
        assert.strictEqual(restoredOrder.status, 'payment_review');
        assert.strictEqual(restoredOrder.total_amount, 123.45);
        assert.strictEqual(restoredOrder.customer_name, 'Alice Recovery');
        assert.strictEqual(restoredOrder.customer_phone, '+233 24 111 2222');
        assert.strictEqual(restoredOrder.customer_email, 'alice@example.com');
        assert.strictEqual(restoredOrder.customer_account_id, account.lastID);
        assert.match(restoredOrder.notes, /product.*delivery.*confirm/i);
        assert.strictEqual(restoredPayment.status, 'paid');
        assert.strictEqual(restoredPayment.provider, 'paystack');
        assert.strictEqual(restoredPayment.provider_reference, 'DCK-RECOVER-001');
        assert.strictEqual(restoredPayment.provider_transaction_id, '7001');
        assert.strictEqual(restoredPayment.amount, 123.45);
        assert.strictEqual(restoredPayment.currency, 'GHS');
        assert.strictEqual(restoredPayment.channel, 'mobile_money');
        assert.strictEqual(restoredPayment.paid_at, '2026-08-19T04:35:00.000Z');
        assert.strictEqual(restoredPayment.gateway_response, null);
        assert.strictEqual(restoredPayment.owner_notified_at, null);
    });
    const collisionOrder = await get(db, `SELECT * FROM orders WHERE customer_email = 'second@example.com'`);
    await check('order-number collision gets a unique recovery number without linking an account', () => {
        assert.notStrictEqual(collisionOrder.order_number, 'ORD-COLLISION');
        assert.match(collisionOrder.order_number, /^REC-/);
        assert.strictEqual(collisionOrder.customer_account_id, null);
    });
    await check('restore creates no items, changes no stock, and recognizes no order revenue', async () => {
        assert.strictEqual((await get(db, 'SELECT COUNT(*) AS count FROM order_items')).count, 0);
        assert.strictEqual((await get(db, 'SELECT stock FROM products WHERE id = 1')).stock, 17);
        assert.strictEqual((await get(db, `SELECT COUNT(*) AS count FROM orders
            WHERE status IN ('paid', 'processing', 'shipped', 'dispatched', 'delivered', 'completed')
              AND id IN (?, ?)` , [restoredOrder.id, collisionOrder.id])).count, 0);
    });
    await close(db);

    const appliedReportText = fs.readFileSync(applyReportPath, 'utf8');
    await check('apply report masks identity and never serializes input payloads or metadata', () => {
        assert.match(appliedReportText, /a\*\*\*@example\.com/);
        ['alice@example.com', 'Alice Recovery', '+233 24 111 2222', 'Sensitive Street',
            'never copy raw metadata', 'AUTH_secret', 'metadata', 'gateway_response'].forEach((secret) => {
            assert.ok(!appliedReportText.includes(secret), `report leaked ${secret}`);
        });
    });

    const replay = executeCli(dbPath, inputPath, replayReportPath, ['--apply', '--verified-export', '--backup-confirmed']);
    await check('replay is idempotent through provider references', () => {
        assert.strictEqual(replay.status, 0, replay.stderr);
        const report = JSON.parse(fs.readFileSync(replayReportPath, 'utf8'));
        assert.strictEqual(report.summary.restored, 0);
        assert.strictEqual(report.summary.alreadyPresent, 3);
        assert.strictEqual(report.summary.incompleteReview, 0);
    });
    db = await openDatabase(dbPath);
    await check('replay creates no duplicate orders or payments', async () => {
        assert.strictEqual((await get(db, 'SELECT COUNT(*) AS count FROM orders')).count, 4);
        assert.strictEqual((await get(db, 'SELECT COUNT(*) AS count FROM payments')).count, 3);
    });
    await close(db);

    const existingReportBytes = fs.readFileSync(dryReportPath);
    const existingReportResult = executeCli(dbPath, inputPath, dryReportPath);
    await check('an existing report is rejected and never overwritten', () => {
        assert.notStrictEqual(existingReportResult.status, 0);
        assert.deepStrictEqual(fs.readFileSync(dryReportPath), existingReportBytes);
    });

    async function createPathGuardFixture(label) {
        const root = path.join(tempRoot, `path-guard-${label}`);
        const guardedDbPath = path.join(root, 'database', 'inventory.db');
        const guardedInputPath = path.join(root, 'export.json');
        const guardedDb = await createSchema(guardedDbPath);
        await close(guardedDb);
        fs.writeFileSync(guardedInputPath, JSON.stringify([successfulTransaction({
            id: `8${label.length}01`,
            reference: `DCK-GUARD-${label.toUpperCase().replace(/[^A-Z0-9]/g, '-')}`
        })]));
        return { root, guardedDbPath, guardedInputPath };
    }

    const exact = await createPathGuardFixture('exact');
    const exactDbBytes = fs.readFileSync(exact.guardedDbPath);
    const exactResult = executeCli(exact.guardedDbPath, exact.guardedInputPath, exact.guardedDbPath);
    await check('report path equal to DB_PATH is rejected without changing the database', () => {
        assert.notStrictEqual(exactResult.status, 0);
        assert.deepStrictEqual(fs.readFileSync(exact.guardedDbPath), exactDbBytes);
    });

    const inputCollision = await createPathGuardFixture('input');
    const inputBytes = fs.readFileSync(inputCollision.guardedInputPath);
    const inputCollisionResult = executeCli(
        inputCollision.guardedDbPath, inputCollision.guardedInputPath, inputCollision.guardedInputPath);
    await check('report path equal to the input export is rejected without changing the export', () => {
        assert.notStrictEqual(inputCollisionResult.status, 0);
        assert.deepStrictEqual(fs.readFileSync(inputCollision.guardedInputPath), inputBytes);
    });

    const linkedParent = await createPathGuardFixture('linked-parent');
    const junctionPath = path.join(linkedParent.root, 'database-alias');
    fs.symlinkSync(path.dirname(linkedParent.guardedDbPath), junctionPath, 'junction');
    const linkedParentDbBytes = fs.readFileSync(linkedParent.guardedDbPath);
    const linkedParentResult = executeCli(linkedParent.guardedDbPath, linkedParent.guardedInputPath,
        path.join(junctionPath, path.basename(linkedParent.guardedDbPath)));
    await check('report through a symlink or junction parent is rejected without changing the database', () => {
        assert.notStrictEqual(linkedParentResult.status, 0);
        assert.deepStrictEqual(fs.readFileSync(linkedParent.guardedDbPath), linkedParentDbBytes);
    });

    const symlinkOutput = await createPathGuardFixture('symlink-output');
    const symlinkTarget = path.join(symlinkOutput.root, 'protected.json');
    const symlinkReport = path.join(symlinkOutput.root, 'report-link.json');
    fs.writeFileSync(symlinkTarget, 'protected symlink target');
    fs.symlinkSync(symlinkTarget, symlinkReport, 'file');
    const symlinkResult = executeCli(symlinkOutput.guardedDbPath, symlinkOutput.guardedInputPath, symlinkReport);
    await check('symlink report output is rejected without changing its target', () => {
        assert.notStrictEqual(symlinkResult.status, 0);
        assert.strictEqual(fs.readFileSync(symlinkTarget, 'utf8'), 'protected symlink target');
    });

    const hardlink = await createPathGuardFixture('hardlink');
    const hardlinkReport = path.join(hardlink.root, 'database-hardlink.db');
    fs.linkSync(hardlink.guardedDbPath, hardlinkReport);
    const hardlinkDbBytes = fs.readFileSync(hardlink.guardedDbPath);
    const hardlinkResult = executeCli(hardlink.guardedDbPath, hardlink.guardedInputPath, hardlinkReport);
    await check('hard-link report alias is rejected without changing the database', () => {
        assert.notStrictEqual(hardlinkResult.status, 0);
        assert.deepStrictEqual(fs.readFileSync(hardlink.guardedDbPath), hardlinkDbBytes);
    });

    const missingParent = await createPathGuardFixture('missing-parent');
    const missingReportParent = path.join(missingParent.root, 'not-created');
    const missingParentResult = executeCli(missingParent.guardedDbPath, missingParent.guardedInputPath,
        path.join(missingReportParent, 'report.json'));
    await check('report parent must already exist and is never created by the CLI', () => {
        assert.notStrictEqual(missingParentResult.status, 0);
        assert.ok(!fs.existsSync(missingReportParent));
    });

    const sideEffectDbPath = path.join(tempRoot, 'side-effects', 'database', 'inventory.db');
    db = await createSchema(sideEffectDbPath);
    await close(db);
    const sideEffectInput = path.join(tempRoot, 'side-effects', 'export.json');
    const sideEffectReportDir = path.join(tempRoot, 'side-effects', 'reports');
    const missingUploads = path.join(tempRoot, 'side-effects', 'durable', 'uploads');
    const missingBackups = path.join(tempRoot, 'side-effects', 'durable', 'backups');
    fs.writeFileSync(sideEffectInput, JSON.stringify([successfulTransaction({
        id: 8901,
        reference: 'DCK-SIDE-EFFECTS'
    })]));
    fs.mkdirSync(sideEffectReportDir, { recursive: true });
    const sideEffectResult = executeCli(sideEffectDbPath, sideEffectInput,
        path.join(sideEffectReportDir, 'report.json'), [], {
            UPLOAD_DIR: missingUploads,
            BACKUP_DIR: missingBackups
        });
    await check('dry-run creates only its report and no configured durable directories', () => {
        assert.strictEqual(sideEffectResult.status, 0, sideEffectResult.stderr);
        assert.ok(!fs.existsSync(missingUploads));
        assert.ok(!fs.existsSync(missingBackups));
        assert.ok(fs.existsSync(path.join(sideEffectReportDir, 'report.json')));
    });

    const adversarialDbPath = path.join(tempRoot, 'adversarial', 'inventory.db');
    db = await createSchema(adversarialDbPath);
    await close(db);
    const adversarialInput = path.join(tempRoot, 'adversarial', 'export.json');
    const adversarialReport = path.join(tempRoot, 'adversarial', 'report.json');
    const adversarialRows = [
        [],
        successfulTransaction({ id: 9001, reference: 'DCK-TYPE-STATUS', status: ['success'] }),
        successfulTransaction({ id: 9002, reference: 'DCK-TYPE-CURRENCY', currency: ['GHS'] }),
        successfulTransaction({ id: 9003, reference: 'DCK-TYPE-AMOUNT-STRING', amount: '12345' }),
        successfulTransaction({ id: 9004, reference: 'DCK-TYPE-AMOUNT-BOOL', amount: true }),
        successfulTransaction({ id: 9005, reference: ['DCK-TYPE-REFERENCE'] }),
        successfulTransaction({ id: { secret: 'transaction-object-secret' }, reference: 'DCK-TYPE-ID-OBJECT' }),
        successfulTransaction({ id: '9e3', reference: 'DCK-TYPE-ID-FORMAT' }),
        successfulTransaction({ id: 9008, reference: 'DCK-TYPE-TIMESTAMP', paid_at: '0' }),
        successfulTransaction({ id: 9009, reference: 'DCK-TYPE-METADATA', metadata: null }),
        successfulTransaction({ id: 9010, reference: 'DCK-TYPE-CUSTOMER', customer: ['private-customer-array'] }),
        successfulTransaction({
            id: 9011,
            reference: 'DCK-TYPE-SOURCE',
            metadata: { source_app: ['dckids'], order_number: 'ORD-TYPE-SOURCE' }
        }),
        successfulTransaction({
            id: 9012,
            reference: 'DCK-TYPE-ORDER-NUMBER',
            metadata: { source_app: 'dckids', order_number: 12345 }
        }),
        successfulTransaction({ id: 9013, reference: 'DCK-TYPE-CHANNEL', channel: { secret: 'channel-object-secret' } }),
        successfulTransaction({
            id: 9014,
            reference: 'DCK-TYPE-NAME',
            customer: { email: 'valid@example.com', first_name: ['private-name-array'], last_name: 'Buyer', phone: '0200000000' }
        }),
        successfulTransaction({
            id: 9015,
            reference: 'DCK-TYPE-EMAIL',
            customer: { email: ['private-array-email@example.com'], first_name: 'Valid', last_name: 'Buyer', phone: '0200000000' }
        }),
        successfulTransaction({
            id: 9016,
            reference: 'DCK-TYPE-PHONE',
            customer: { email: 'valid2@example.com', first_name: 'Valid', last_name: 'Buyer', phone: { secret: 'phone-object-secret' } }
        }),
        successfulTransaction({ id: 9017, reference: 'DCK-TYPE-LONG-CHANNEL', channel: 'x'.repeat(65) }),
        successfulTransaction({
            id: 9018,
            reference: 'DCK-TYPE-BAD-EMAIL',
            customer: { email: 'not-an-email', first_name: 'Valid', last_name: 'Buyer', phone: '0200000000' }
        }),
        successfulTransaction({ id: 9019, reference: 'DCK-TYPE-CHANNEL-TOKEN', channel: 'alice-phone-token' }),
        successfulTransaction({ id: '0', reference: 'DCK-TYPE-ID-ZERO' }),
        successfulTransaction({ id: '000000', reference: 'DCK-TYPE-ID-ALL-ZERO' }),
        successfulTransaction({ id: '+9022', reference: 'DCK-TYPE-ID-PLUS' }),
        successfulTransaction({ id: '-9023', reference: 'DCK-TYPE-ID-MINUS' }),
        successfulTransaction({ id: '9024.5', reference: 'DCK-TYPE-ID-DECIMAL' }),
        successfulTransaction({ id: ' 9025 ', reference: 'DCK-TYPE-ID-WHITESPACE' }),
        successfulTransaction({ id: '9'.repeat(33), reference: 'DCK-TYPE-ID-TOO-LONG' }),
        successfulTransaction({ id: 9027, reference: 'DCK-TYPE-CALENDAR-DATE', paid_at: '2026-02-30T00:00:00Z' })
    ];
    fs.writeFileSync(adversarialInput, JSON.stringify(adversarialRows));
    const adversarialResult = executeCli(adversarialDbPath, adversarialInput, adversarialReport,
        ['--apply', '--verified-export', '--backup-confirmed']);
    await check('adversarial JSON types and formats are all rejected', () => {
        assert.strictEqual(adversarialResult.status, 0, adversarialResult.stderr);
        const report = JSON.parse(fs.readFileSync(adversarialReport, 'utf8'));
        assert.strictEqual(report.summary.input, adversarialRows.length);
        assert.strictEqual(report.summary.rejected, adversarialRows.length);
        assert.strictEqual(report.summary.restored, 0);
        assert.strictEqual(report.summary.wouldRestore, 0);
    });
    db = await openDatabase(adversarialDbPath);
    await check('malformed values never reach orders or payments', async () => {
        assert.strictEqual((await get(db, 'SELECT COUNT(*) AS count FROM orders')).count, 0);
        assert.strictEqual((await get(db, 'SELECT COUNT(*) AS count FROM payments')).count, 0);
    });
    await close(db);
    const adversarialReportText = fs.readFileSync(adversarialReport, 'utf8');
    await check('malformed values and their private markers never reach the report', () => {
        ['transaction-object-secret', 'private-customer-array', 'channel-object-secret',
            'private-name-array', 'private-array-email@example.com', 'phone-object-secret',
            'not-an-email', 'alice-phone-token'].forEach((privateValue) => {
            assert.ok(!adversarialReportText.includes(privateValue), `report leaked ${privateValue}`);
        });
    });

    const nullableDbPath = path.join(tempRoot, 'nullable-customer', 'inventory.db');
    db = await createSchema(nullableDbPath);
    await close(db);
    const nullableInput = path.join(tempRoot, 'nullable-customer', 'export.json');
    const nullableReport = path.join(tempRoot, 'nullable-customer', 'report.json');
    const nullableTransaction = successfulTransaction({
        id: 9030,
        reference: 'DCK-NULLABLE-CUSTOMER',
        customer: { email: null, first_name: null, last_name: null, name: null, phone: null },
        metadata: { source_app: 'dckids', order_number: 'ORD-NULLABLE-CUSTOMER' }
    });
    delete nullableTransaction.channel;
    fs.writeFileSync(nullableInput, JSON.stringify([nullableTransaction]));
    const nullableResult = executeCli(nullableDbPath, nullableInput, nullableReport,
        ['--apply', '--verified-export', '--backup-confirmed']);
    await check('nullable optional customer identity fields are treated as absent', () => {
        assert.strictEqual(nullableResult.status, 0, nullableResult.stderr);
        const report = JSON.parse(fs.readFileSync(nullableReport, 'utf8'));
        assert.strictEqual(report.summary.restored, 1);
        assert.strictEqual(report.restored[0].maskedEmail, null);
        assert.strictEqual(report.restored[0].channel, null);
    });
    db = await openDatabase(nullableDbPath);
    await check('nullable customer identity is stored as SQL null', async () => {
        const order = await get(db, `SELECT customer_name, customer_phone, customer_email
            FROM orders WHERE order_number = 'ORD-NULLABLE-CUSTOMER'`);
        assert.deepStrictEqual(order, { customer_name: null, customer_phone: null, customer_email: null });
    });
    await close(db);

    const officialChannels = [
        'card', 'bank', 'apple_pay', 'ussd', 'qr', 'mobile_money',
        'bank_transfer', 'eft', 'capitec_pay', 'payattitude'
    ];
    const channelInput = path.join(tempRoot, 'nullable-customer', 'channels.json');
    const channelReport = path.join(tempRoot, 'nullable-customer', 'channels-report.json');
    fs.writeFileSync(channelInput, JSON.stringify(officialChannels.map((channel, index) => successfulTransaction({
        id: 9040 + index,
        reference: `DCK-OFFICIAL-CHANNEL-${index}`,
        channel,
        metadata: { source_app: 'dckids', order_number: `ORD-OFFICIAL-CHANNEL-${index}` }
    }))));
    const channelResult = executeCli(nullableDbPath, channelInput, channelReport);
    await check('every official Paystack channel remains accepted and preserved', () => {
        assert.strictEqual(channelResult.status, 0, channelResult.stderr);
        const report = JSON.parse(fs.readFileSync(channelReport, 'utf8'));
        assert.strictEqual(report.summary.wouldRestore, officialChannels.length);
        assert.deepStrictEqual(report.wouldRestore.map((entry) => entry.channel), officialChannels);
    });

    const minimalInput = path.join(tempRoot, 'adversarial', 'minimal.json');
    const minimalReport = path.join(tempRoot, 'adversarial', 'minimal-report.json');
    fs.writeFileSync(minimalInput, JSON.stringify([{
        id: '9020',
        reference: 'DCK-MINIMAL-VALID',
        status: 'success',
        amount: 100,
        currency: 'GHS',
        paid_at: '2026-08-20T00:00:00Z',
        metadata: {},
        customer: {}
    }]));
    const minimalResult = executeCli(adversarialDbPath, minimalInput, minimalReport);
    await check('bounded optional strings may be absent from an otherwise valid record', () => {
        assert.strictEqual(minimalResult.status, 0, minimalResult.stderr);
        const report = JSON.parse(fs.readFileSync(minimalReport, 'utf8'));
        assert.strictEqual(report.summary.wouldRestore, 1);
        assert.strictEqual(report.summary.rejected, 0);
    });

    const rollbackDbPath = path.join(tempRoot, 'rollback', 'inventory.db');
    db = await createSchema(rollbackDbPath);
    await run(db, `CREATE TRIGGER fail_recovery_payment BEFORE INSERT ON payments
        WHEN NEW.provider_reference = 'DCK-ROLLBACK-001'
        BEGIN SELECT RAISE(ABORT, 'forced payment failure'); END`);
    await close(db);
    const rollbackInput = path.join(tempRoot, 'rollback.json');
    const rollbackReport = path.join(tempRoot, 'rollback-report.json');
    fs.writeFileSync(rollbackInput, JSON.stringify([successfulTransaction({
        id: 7200,
        reference: 'DCK-ROLLBACK-001',
        metadata: { source_app: 'dckids', order_number: 'ORD-ROLLBACK-001' }
    })]));
    const rollbackResult = executeCli(rollbackDbPath, rollbackInput, rollbackReport,
        ['--apply', '--verified-export', '--backup-confirmed']);
    await check('database failure is reported without exposing internal error details', () => {
        assert.notStrictEqual(rollbackResult.status, 0);
        const report = JSON.parse(fs.readFileSync(rollbackReport, 'utf8'));
        assert.strictEqual(report.summary.restored, 0);
        assert.strictEqual(report.summary.rejected, 1);
        assert.strictEqual(report.rejected[0].reason, 'restore_failed');
        assert.ok(!JSON.stringify(report).includes('forced payment failure'));
    });
    db = await openDatabase(rollbackDbPath);
    await check('payment failure rolls back the partially inserted order', async () => {
        assert.strictEqual((await get(db, 'SELECT COUNT(*) AS count FROM orders')).count, 0);
        assert.strictEqual((await get(db, 'SELECT COUNT(*) AS count FROM payments')).count, 0);
    });
    await close(db);

    console.log(`\n${passed} passed, 0 failed`);
}

runTests()
    .catch((error) => {
        console.error('FATAL:', error);
        process.exitCode = 1;
    })
    .finally(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
