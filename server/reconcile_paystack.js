#!/usr/bin/env node
/* Offline, idempotent recovery for verified Paystack transaction exports. */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { DB_PATH } = require('./storage');

const REVIEW_NOTES = 'Recovered from a verified Paystack export; product and delivery details need confirmation.';
const REFERENCE_PATTERN = /^DCK-[A-Za-z0-9][A-Za-z0-9-]{0,126}$/;
const ORDER_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

function parseArguments(argv) {
    const options = { apply: false, verifiedExport: false, backupConfirmed: false };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--apply') options.apply = true;
        else if (argument === '--verified-export') options.verifiedExport = true;
        else if (argument === '--backup-confirmed') options.backupConfirmed = true;
        else if (argument === '--input' || argument === '--report') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`${argument} requires a file path`);
            options[argument === '--input' ? 'inputPath' : 'reportPath'] = path.resolve(value);
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    if (!options.inputPath || !options.reportPath) throw new Error('--input and --report are required');
    if (options.apply && (!options.verifiedExport || !options.backupConfirmed)) {
        throw new Error('--apply requires both --verified-export and --backup-confirmed');
    }
    return options;
}

function openDatabase(filename, apply) {
    const mode = apply ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY;
    return new Promise((resolve, reject) => {
        const database = new sqlite3.Database(filename, mode, (error) => error ? reject(error) : resolve(database));
    });
}

function closeDatabase(database) {
    return new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()));
}

function dbGet(database, sql, params = []) {
    return new Promise((resolve, reject) => database.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

function dbAll(database, sql, params = []) {
    return new Promise((resolve, reject) => database.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}

function dbRun(database, sql, params = []) {
    return new Promise((resolve, reject) => database.run(sql, params, function (error) {
        if (error) reject(error);
        else resolve(this);
    }));
}

function safeText(value, maximumLength) {
    if (value == null) return null;
    const normalized = String(value).trim();
    return normalized && normalized.length <= maximumLength ? normalized : null;
}

function maskEmail(email) {
    if (!email) return null;
    const separator = email.indexOf('@');
    if (separator < 1) return null;
    return `${email[0]}***${email.slice(separator).toLowerCase()}`;
}

function normalizeEmail(value) {
    const email = safeText(value, 254);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return email.toLowerCase();
}

function reject(reason) {
    return { valid: false, reason };
}

function normalizeTransaction(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return reject('malformed_record');
    if (String(record.status || '').toLowerCase() !== 'success') return reject('not_successful');
    if (String(record.currency || '').toUpperCase() !== 'GHS') return reject('unsupported_currency');

    const reference = safeText(record.reference, 130);
    if (!reference || !REFERENCE_PATTERN.test(reference)) return reject('invalid_reference');
    if (!Number.isSafeInteger(Number(record.amount)) || Number(record.amount) <= 0) return reject('invalid_amount');

    const transactionId = safeText(record.id, 128);
    if (!transactionId) return reject('missing_transaction_id');
    const paidAt = safeText(record.paid_at || record.paidAt, 64);
    if (!paidAt || Number.isNaN(Date.parse(paidAt))) return reject('invalid_paid_timestamp');

    const metadata = record.metadata == null ? {} : record.metadata;
    if (typeof metadata !== 'object' || Array.isArray(metadata)) return reject('incompatible_source');
    const sourceApp = safeText(metadata.source_app, 64);
    if (sourceApp && sourceApp.toLowerCase() !== 'dckids') return reject('incompatible_source');

    const customer = record.customer && typeof record.customer === 'object' && !Array.isArray(record.customer)
        ? record.customer
        : {};
    const firstName = safeText(customer.first_name, 100);
    const lastName = safeText(customer.last_name, 100);
    const combinedName = [firstName, lastName].filter(Boolean).join(' ');
    const customerName = safeText(combinedName || customer.name, 200);
    const customerPhone = safeText(customer.phone, 50);
    const customerEmail = normalizeEmail(customer.email);
    const metadataOrderNumber = safeText(metadata.order_number, 100);

    return {
        valid: true,
        reference,
        transactionId,
        amount: Number(record.amount) / 100,
        currency: 'GHS',
        channel: safeText(record.channel, 64),
        paidAt,
        customerName,
        customerPhone,
        customerEmail,
        metadataOrderNumber: metadataOrderNumber && ORDER_NUMBER_PATTERN.test(metadataOrderNumber)
            ? metadataOrderNumber
            : null
    };
}

function reportEntry(transaction, extra = {}) {
    return Object.assign({
        reference: transaction.reference,
        providerTransactionId: transaction.transactionId,
        amount: transaction.amount,
        currency: transaction.currency,
        channel: transaction.channel,
        paidAt: transaction.paidAt,
        maskedEmail: maskEmail(transaction.customerEmail)
    }, extra);
}

function rejectedEntry(index, reason, transaction) {
    const entry = { index, status: 'rejected', reason };
    if (transaction && transaction.reference) entry.reference = transaction.reference;
    return entry;
}

async function uniqueOrderNumber(database, preferred, reference) {
    if (preferred && !(await dbGet(database, 'SELECT 1 FROM orders WHERE order_number = ?', [preferred]))) return preferred;
    const base = `REC-${reference}`.slice(0, 96);
    let candidate = base;
    let suffix = 1;
    while (await dbGet(database, 'SELECT 1 FROM orders WHERE order_number = ?', [candidate])) {
        suffix++;
        candidate = `${base.slice(0, 95 - String(suffix).length)}-${suffix}`;
    }
    return candidate;
}

async function linkedCustomerAccount(database, email) {
    if (!email) return null;
    const matches = await dbAll(database,
        'SELECT id FROM customer_accounts WHERE lower(email) = lower(?) ORDER BY id LIMIT 2', [email]);
    return matches.length === 1 ? matches[0].id : null;
}

async function restoreTransaction(database, transaction) {
    let transactionOpen = false;
    try {
        await dbRun(database, 'BEGIN IMMEDIATE');
        transactionOpen = true;
        const present = await dbGet(database,
            'SELECT o.order_number FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.provider_reference = ?',
            [transaction.reference]);
        if (present) {
            await dbRun(database, 'COMMIT');
            transactionOpen = false;
            return { alreadyPresent: true, orderNumber: present.order_number };
        }
        const transactionCollision = await dbGet(database,
            'SELECT 1 FROM payments WHERE provider_transaction_id = ?', [transaction.transactionId]);
        if (transactionCollision) {
            await dbRun(database, 'ROLLBACK');
            transactionOpen = false;
            return { rejected: true, reason: 'transaction_id_conflict' };
        }

        const orderNumber = await uniqueOrderNumber(database, transaction.metadataOrderNumber, transaction.reference);
        const customerAccountId = await linkedCustomerAccount(database, transaction.customerEmail);
        const order = await dbRun(database,
            `INSERT INTO orders
                (order_number, customer_name, customer_phone, customer_email, order_type, total_amount, status,
                 notes, customer_account_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'recovery', ?, 'payment_review', ?, ?, ?, ?)`,
            [orderNumber, transaction.customerName, transaction.customerPhone, transaction.customerEmail,
                transaction.amount, REVIEW_NOTES, customerAccountId, transaction.paidAt, transaction.paidAt]);
        await dbRun(database,
            `INSERT INTO payments
                (order_id, payment_method, amount, status, provider, provider_reference, provider_transaction_id,
                 currency, channel, gateway_response, paid_at, owner_notified_at, updated_at, created_at)
             VALUES (?, 'Paystack', ?, 'paid', 'paystack', ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
            [order.lastID, transaction.amount, transaction.reference, transaction.transactionId,
                transaction.currency, transaction.channel, transaction.paidAt, transaction.paidAt, transaction.paidAt]);
        await dbRun(database, 'COMMIT');
        transactionOpen = false;
        return { restored: true, orderNumber };
    } catch (error) {
        if (transactionOpen) {
            try {
                await dbRun(database, 'ROLLBACK');
            } catch (rollbackError) {
                // The report deliberately excludes internal SQLite details.
            }
        }
        return { rejected: true, reason: 'restore_failed', hardFailure: true };
    }
}

async function reconcile(database, records, apply) {
    const report = {
        mode: apply ? 'apply' : 'dry-run',
        summary: {
            input: records.length,
            wouldRestore: 0,
            restored: 0,
            alreadyPresent: 0,
            incompleteReview: 0,
            rejected: 0
        },
        wouldRestore: [],
        restored: [],
        alreadyPresent: [],
        rejected: []
    };
    let hardFailure = false;

    for (let index = 0; index < records.length; index++) {
        const transaction = normalizeTransaction(records[index]);
        if (!transaction.valid) {
            report.rejected.push(rejectedEntry(index, transaction.reason));
            continue;
        }
        const present = await dbGet(database,
            'SELECT o.order_number FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.provider_reference = ?',
            [transaction.reference]);
        if (present) {
            report.alreadyPresent.push(reportEntry(transaction, { status: 'already_present', orderNumber: present.order_number }));
            continue;
        }
        const transactionCollision = await dbGet(database,
            'SELECT 1 FROM payments WHERE provider_transaction_id = ?', [transaction.transactionId]);
        if (transactionCollision) {
            report.rejected.push(rejectedEntry(index, 'transaction_id_conflict', transaction));
            continue;
        }
        if (!apply) {
            const orderNumber = await uniqueOrderNumber(database, transaction.metadataOrderNumber, transaction.reference);
            report.wouldRestore.push(reportEntry(transaction, {
                status: 'would_restore',
                orderNumber,
                reviewState: 'incomplete_review'
            }));
            continue;
        }

        const result = await restoreTransaction(database, transaction);
        if (result.alreadyPresent) {
            report.alreadyPresent.push(reportEntry(transaction, { status: 'already_present', orderNumber: result.orderNumber }));
        } else if (result.restored) {
            report.restored.push(reportEntry(transaction, {
                status: 'restored',
                orderNumber: result.orderNumber,
                reviewState: 'incomplete_review'
            }));
        } else {
            report.rejected.push(rejectedEntry(index, result.reason, transaction));
            hardFailure = hardFailure || Boolean(result.hardFailure);
        }
    }

    report.summary.wouldRestore = report.wouldRestore.length;
    report.summary.restored = report.restored.length;
    report.summary.alreadyPresent = report.alreadyPresent.length;
    report.summary.incompleteReview = report.restored.filter((entry) => entry.reviewState === 'incomplete_review').length;
    report.summary.rejected = report.rejected.length;
    return { report, hardFailure };
}

function readExport(inputPath) {
    const parsed = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const records = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.data) ? parsed.data : null;
    if (!records) throw new Error('Paystack export must be an array or an object with a data array');
    return records;
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const records = readExport(options.inputPath);
    const database = await openDatabase(DB_PATH, options.apply);
    let result;
    try {
        result = await reconcile(database, records, options.apply);
    } finally {
        await closeDatabase(database);
    }
    fs.mkdirSync(path.dirname(options.reportPath), { recursive: true });
    fs.writeFileSync(options.reportPath, `${JSON.stringify(result.report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`Reconciliation ${result.report.mode}: ${result.report.summary.restored} restored, ` +
        `${result.report.summary.alreadyPresent} already present, ${result.report.summary.rejected} rejected.\n`);
    if (result.hardFailure) process.exitCode = 1;
}

main().catch((error) => {
    process.stderr.write(`Paystack reconciliation failed: ${error.message}\n`);
    process.exitCode = 1;
});
