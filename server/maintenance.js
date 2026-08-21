function isMaintenanceEnabled(value = process.env.MAINTENANCE_MODE) {
    return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function createMaintenanceMiddleware(options = {}) {
    const enabled = options.enabled == null
        ? isMaintenanceEnabled()
        : Boolean(options.enabled);
    const retryAfterSeconds = Number.isInteger(options.retryAfterSeconds) && options.retryAfterSeconds > 0
        ? options.retryAfterSeconds
        : 300;

    return function maintenanceMiddleware(req, res, next) {
        if (!enabled || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
        res.setHeader('Retry-After', String(retryAfterSeconds));
        return res.status(503).json({
            error: 'The store is temporarily unavailable for maintenance. Please try again shortly.',
            code: 'maintenance'
        });
    };
}

module.exports = { createMaintenanceMiddleware, isMaintenanceEnabled };
