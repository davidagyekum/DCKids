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
const volumeName = String(process.env.RAILWAY_VOLUME_NAME || '').trim();

function resolveConfiguredPath(value, fallback) {
    return path.resolve(String(value || fallback));
}

function isWithinDirectory(targetPath, directoryPath) {
    const relative = path.relative(directoryPath, targetPath);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

// Resolve every existing path segment while retaining missing trailing
// segments. This detects a configured directory whose existing ancestor is a
// symlink escaping the Railway volume before mkdir/write operations follow it.
function resolvePhysicalPath(targetPath) {
    let candidate = path.resolve(targetPath);
    const missingSegments = [];
    while (true) {
        try {
            const resolvedAncestor = fs.realpathSync.native(candidate);
            return path.resolve(resolvedAncestor, ...missingSegments);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw new Error(`Unable to resolve durable storage path: ${targetPath}`, { cause: error });
            }
            const parent = path.dirname(candidate);
            if (parent === candidate) {
                throw new Error(`Unable to resolve durable storage path: ${targetPath}`, { cause: error });
            }
            missingSegments.unshift(path.basename(candidate));
            candidate = parent;
        }
    }
}

if (isRailwayProduction && !volumeMountPath) {
    throw new Error('RAILWAY_VOLUME_MOUNT_PATH is required for Railway production durable storage.');
}
if (isRailwayProduction && !volumeName) {
    throw new Error('RAILWAY_VOLUME_NAME is required for Railway production durable storage.');
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

const physicalUploadPath = resolvePhysicalPath(UPLOAD_DIR);
[
    ['DB_PATH', DB_PATH],
    ['BACKUP_DIR', BACKUP_DIR]
].forEach(([name, privatePath]) => {
    if (isWithinDirectory(resolvePhysicalPath(privatePath), physicalUploadPath)) {
        throw new Error(`${name} cannot equal or be nested beneath the public UPLOAD_DIR.`);
    }
});

if (isRailwayProduction) {
    const physicalVolumePath = resolvePhysicalPath(VOLUME_PATH);
    [DB_PATH, UPLOAD_DIR, BACKUP_DIR].forEach((durablePath) => {
        if (!isWithinDirectory(resolvePhysicalPath(durablePath), physicalVolumePath)) {
            throw new Error(`Configured durable path resolves outside the mounted volume: ${durablePath}`);
        }
    });
}

function ensureWritableDirectory(directoryPath) {
    fs.mkdirSync(directoryPath, { recursive: true });
    fs.accessSync(directoryPath, fs.constants.W_OK);
}

function ensureStorageReady() {
    ensureDatabaseReady();
    ensureUploadReady();
    ensureBackupReady();
}

function ensureDatabaseReady() {
    ensureWritableDirectory(path.dirname(DB_PATH));
}

function ensureUploadReady() {
    ensureWritableDirectory(UPLOAD_DIR);
}

function ensureBackupReady() {
    ensureWritableDirectory(BACKUP_DIR);
}

module.exports = {
    DB_PATH,
    UPLOAD_DIR,
    BACKUP_DIR,
    VOLUME_PATH,
    isRailwayProduction,
    ensureDatabaseReady,
    ensureUploadReady,
    ensureBackupReady,
    ensureStorageReady
};
