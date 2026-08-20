// Durable storage locations for the database, uploaded product images, and
// database backups. Keep all path decisions here so every persistence feature
// agrees about the Railway volume boundary.
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const isRailwayProduction = process.env.NODE_ENV === 'production' && Boolean(
    process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID
);
const volumeMountPath = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || '').trim();

function resolveConfiguredPath(value, fallback) {
    return path.resolve(String(value || fallback));
}

function isWithinDirectory(targetPath, directoryPath) {
    const relative = path.relative(directoryPath, targetPath);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

if (isRailwayProduction && !volumeMountPath) {
    throw new Error('RAILWAY_VOLUME_MOUNT_PATH is required for Railway production durable storage.');
}

const VOLUME_PATH = isRailwayProduction ? path.resolve(volumeMountPath) : null;
const DB_PATH = resolveConfiguredPath(
    process.env.DB_PATH,
    VOLUME_PATH ? path.join(VOLUME_PATH, 'inventory.db') : path.join(__dirname, 'inventory.db')
);
const UPLOAD_DIR = resolveConfiguredPath(
    process.env.UPLOAD_DIR,
    VOLUME_PATH ? path.join(VOLUME_PATH, 'uploads') : path.join(PROJECT_ROOT, 'images')
);
const BACKUP_DIR = resolveConfiguredPath(
    process.env.BACKUP_DIR,
    VOLUME_PATH ? path.join(VOLUME_PATH, 'backups') : path.join(__dirname, 'backups')
);

if (isRailwayProduction) {
    [DB_PATH, UPLOAD_DIR, BACKUP_DIR].forEach((durablePath) => {
        if (!isWithinDirectory(durablePath, VOLUME_PATH)) {
            throw new Error(`Configured durable path resolves outside the mounted volume: ${durablePath}`);
        }
    });
}

function ensureWritableDirectory(directoryPath) {
    fs.mkdirSync(directoryPath, { recursive: true });
    fs.accessSync(directoryPath, fs.constants.W_OK);
}

function ensureStorageReady() {
    ensureWritableDirectory(path.dirname(DB_PATH));
    ensureWritableDirectory(UPLOAD_DIR);
    ensureWritableDirectory(BACKUP_DIR);
}

// This runs during module loading, before db.js opens SQLite.
ensureStorageReady();

module.exports = {
    DB_PATH,
    UPLOAD_DIR,
    BACKUP_DIR,
    VOLUME_PATH,
    isRailwayProduction,
    ensureStorageReady
};
