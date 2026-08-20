#!/usr/bin/env node
/* Offline, idempotent recovery for verified Paystack transaction exports. */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: false });
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { DB_PATH } = require('./storage');

const REVIEW_NOTES = 'Recovered from a verified Paystack export; product and delivery details need confirmation.';
const REFERENCE_PATTERN = /^DCK-[0-9]+-[a-f0-9]{20}$/i;
const ORDER_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const PAYSTACK_CHANNELS = new Set([
    'card', 'bank', 'apple_pay', 'ussd', 'qr', 'mobile_money',
    'bank_transfer', 'eft', 'capitec_pay', 'payattitude'
]);

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

function pathIdentity(value) {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertExistingParentHasNoLinks(reportPath) {
    const parentPath = path.dirname(reportPath);
    const parsed = path.parse(parentPath);
    let currentPath = parsed.root;
    const segments = parentPath.slice(parsed.root.length).split(path.sep).filter(Boolean);
    for (const segment of segments) {
        currentPath = path.join(currentPath, segment);
        const details = fs.lstatSync(currentPath);
        if (details.isSymbolicLink()) throw new Error('Report parent cannot contain a symbolic link or junction');
    }
    if (!fs.statSync(parentPath).isDirectory()) throw new Error('Report parent must be an existing directory');
    return fs.realpathSync.native(parentPath);
}

function validateReportDestination(reportPath, inputPath, databasePath) {
    const reportIdentity = pathIdentity(reportPath);
    if (reportIdentity === pathIdentity(inputPath)) throw new Error('Report destination conflicts with the input export');
    if (reportIdentity === pathIdentity(databasePath)) throw new Error('Report destination conflicts with the database');

    try {
        fs.lstatSync(reportPath);
        throw new Error('Report destination already exists');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const physicalParent = assertExistingParentHasNoLinks(reportPath);
    const physicalReport = pathIdentity(path.join(physicalParent, path.basename(reportPath)));
    const physicalInput = pathIdentity(fs.realpathSync.native(inputPath));
    const physicalDatabase = pathIdentity(fs.realpathSync.native(databasePath));
    if (physicalReport === physicalInput) throw new Error('Report destination aliases the input export');
    if (physicalReport === physicalDatabase) throw new Error('Report destination aliases the database');
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

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype;
}

function optionalString(object, property, maximumLength, pattern, allowNull = false) {
    if (!Object.prototype.hasOwnProperty.call(object, property)) return { valid: true, value: null };
    if (object[property] === null && allowNull) return { valid: true, value: null };
    if (typeof object[property] !== 'string') return { valid: false, value: null };
    const value = object[property].trim();
    if (!value || value.length > maximumLength || (pattern && !pattern.test(value))) {
        return { valid: false, value: null };
    }
    return { valid: true, value };
}

function isValidPaystackTimestamp(value) {
    if (typeof value !== 'string' || value.length > 64) return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match || Number.isNaN(Date.parse(value))) return false;
    const [, year, month, day, hour, minute, second, fraction = '0'] = match;
    const milliseconds = Number(fraction.padEnd(3, '0'));
    const calendar = new Date(0);
    calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
    calendar.setUTCHours(Number(hour), Number(minute), Number(second), milliseconds);
    return calendar.getUTCFullYear() === Number(year) &&
        calendar.getUTCMonth() === Number(month) - 1 &&
        calendar.getUTCDate() === Number(day) &&
        calendar.getUTCHours() === Number(hour) &&
        calendar.getUTCMinutes() === Number(minute) &&
        calendar.getUTCSeconds() === Number(second) &&
        calendar.getUTCMilliseconds() === milliseconds;
}

function maskEmail(email) {
    if (!email) return null;
    const separator = email.indexOf('@');
    if (separator < 1) return null;
    return `${email[0]}***${email.slice(separator).toLowerCase()}`;
}

function normalizeEmail(value) {
    if (typeof value !== 'string') return null;
    const email = value.trim();
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return email.toLowerCase();
}

function reject(reason) {
    return { valid: false, reason };
}

function normalizeTransaction(record) {
    if (!isPlainObject(record)) return reject('malformed_record');
    if (typeof record.status !== 'string' || record.status.length > 32 ||
        record.status.trim().toLowerCase() !== 'success') return reject('not_successful');
    if (typeof record.currency !== 'string' || record.currency.length > 8 ||
        record.currency.trim().toUpperCase() !== 'GHS') return reject('unsupported_currency');
    if (typeof record.reference !== 'string' || record.reference !== record.reference.trim() ||
        !REFERENCE_PATTERN.test(record.reference)) return reject('invalid_reference');
    if (typeof record.amount !== 'number' || !Number.isSafeInteger(record.amount) || record.amount <= 0) {
        return reject('invalid_amount');
    }

    let transactionId;
    if (typeof record.id === 'number' && Number.isSafeInteger(record.id) && record.id > 0) {
        transactionId = String(record.id);
    } else if (typeof record.id === 'string' && /^[0-9]{1,32}$/.test(record.id) && /[1-9]/.test(record.id)) {
        transactionId = record.id;
    } else {
        return reject('missing_transaction_id');
    }

    const paidAtValue = Object.prototype.hasOwnProperty.call(record, 'paid_at') ? record.paid_at : record.paidAt;
    if (!isValidPaystackTimestamp(paidAtValue)) {
        return reject('invalid_paid_timestamp');
    }
    const paidAt = paidAtValue;

    if (!isPlainObject(record.metadata)) return reject('malformed_metadata');
    if (!isPlainObject(record.customer)) return reject('malformed_customer');
    const metadata = record.metadata;
    const customer = record.customer;
    const sourceApp = optionalString(metadata, 'source_app', 64, /^[A-Za-z0-9_-]+$/);
    if (!sourceApp.valid || (sourceApp.value && sourceApp.value.toLowerCase() !== 'dckids')) {
        return reject('incompatible_source');
    }
    const metadataOrderNumber = optionalString(metadata, 'order_number', 100, ORDER_NUMBER_PATTERN);
    if (!metadataOrderNumber.valid) return reject('invalid_order_number');
    const channel = optionalString(record, 'channel', 64, /^[A-Za-z0-9_-]+$/);
    if (!channel.valid || (channel.value && !PAYSTACK_CHANNELS.has(channel.value))) return reject('invalid_channel');
    const firstName = optionalString(customer, 'first_name', 100, null, true);
    const lastName = optionalString(customer, 'last_name', 100, null, true);
    const fallbackName = optionalString(customer, 'name', 200, null, true);
    const phone = optionalString(customer, 'phone', 50, null, true);
    if (!firstName.valid || !lastName.valid || !fallbackName.valid || !phone.valid) {
        return reject('malformed_customer');
    }
    let customerEmail = null;
    if (Object.prototype.hasOwnProperty.call(customer, 'email') && customer.email !== null) {
        customerEmail = normalizeEmail(customer.email);
        if (!customerEmail) return reject('malformed_customer');
    }
    const combinedName = [firstName.value, lastName.value].filter(Boolean).join(' ');
    const customerName = combinedName || fallbackName.value;
    if (customerName && customerName.length > 200) return reject('malformed_customer');

    return {
        valid: true,
        reference: record.reference,
        transactionId,
        amount: record.amount / 100,
        currency: 'GHS',
        channel: channel.value,
        paidAt,
        customerName,
        customerPhone: phone.value,
        customerEmail,
        metadataOrderNumber: metadataOrderNumber.value
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

async function uniqueOrderNumber(database, preferred, reference, reservedOrderNumbers = new Set()) {
    if (preferred && !reservedOrderNumbers.has(preferred) &&
        !(await dbGet(database, 'SELECT 1 FROM orders WHERE order_number = ?', [preferred]))) return preferred;
    const base = `REC-${reference}`.slice(0, 96);
    let candidate = base;
    let suffix = 1;
    while (reservedOrderNumbers.has(candidate) ||
        await dbGet(database, 'SELECT 1 FROM orders WHERE order_number = ?', [candidate])) {
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
    const dryRunReservations = apply ? null : {
        references: new Map(),
        transactionIds: new Set(),
        orderNumbers: new Set()
    };

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
        if (dryRunReservations && dryRunReservations.references.has(transaction.reference)) {
            report.alreadyPresent.push(reportEntry(transaction, {
                status: 'already_present',
                orderNumber: dryRunReservations.references.get(transaction.reference)
            }));
            continue;
        }
        const transactionCollision = await dbGet(database,
            'SELECT 1 FROM payments WHERE provider_transaction_id = ?', [transaction.transactionId]);
        if (transactionCollision || (dryRunReservations && dryRunReservations.transactionIds.has(transaction.transactionId))) {
            report.rejected.push(rejectedEntry(index, 'transaction_id_conflict', transaction));
            continue;
        }
        if (!apply) {
            const orderNumber = await uniqueOrderNumber(
                database, transaction.metadataOrderNumber, transaction.reference, dryRunReservations.orderNumbers);
            dryRunReservations.references.set(transaction.reference, orderNumber);
            dryRunReservations.transactionIds.add(transaction.transactionId);
            dryRunReservations.orderNumbers.add(orderNumber);
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
    validateReportDestination(options.reportPath, options.inputPath, DB_PATH);
    const records = readExport(options.inputPath);
    const reportFile = fs.openSync(options.reportPath, 'wx', 0o600);
    let database;
    try {
        database = await openDatabase(DB_PATH, options.apply);
        const result = await reconcile(database, records, options.apply);
        await closeDatabase(database);
        database = null;
        fs.writeFileSync(reportFile, `${JSON.stringify(result.report, null, 2)}\n`, { encoding: 'utf8' });
        process.stdout.write(`Reconciliation ${result.report.mode}: ${result.report.summary.restored} restored, ` +
            `${result.report.summary.alreadyPresent} already present, ${result.report.summary.rejected} rejected.\n`);
        if (result.hardFailure) process.exitCode = 1;
    } finally {
        if (database) await closeDatabase(database);
        fs.closeSync(reportFile);
    }
}

main().catch((error) => {
    process.stderr.write(`Paystack reconciliation failed: ${error.message}\n`);
    process.exitCode = 1;
});
