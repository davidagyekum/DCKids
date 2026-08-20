'use strict';

(function exposeRecoveryView(root, factory) {
    const recoveryView = factory();
    if (typeof module === 'object' && module.exports) module.exports = recoveryView;
    if (root) root.DcKidsRecoveryView = recoveryView;
})(typeof window !== 'undefined' ? window : globalThis, function createRecoveryViewModule() {
    function hideRecoveryCodeDashboardAlert(documentRef) {
        if (!documentRef || typeof documentRef.getElementById !== 'function') return;
        const alert = documentRef.getElementById('dashboard-recovery-alert');
        const title = documentRef.getElementById('dashboard-recovery-alert-title');
        const message = documentRef.getElementById('dashboard-recovery-alert-message');
        if (alert) {
            alert.hidden = true;
            if (alert.dataset) delete alert.dataset.level;
        }
        if (title) title.textContent = '';
        if (message) message.textContent = '';
    }

    function createRecoveryCodeView(remainingValue, totalValue) {
        const parsedRemaining = Number(remainingValue);
        const parsedTotal = Number(totalValue);
        if (!Number.isFinite(parsedRemaining) || !Number.isFinite(parsedTotal) || parsedTotal < 1) {
            return { valid: false, alert: null };
        }

        const total = Math.max(1, Math.trunc(parsedTotal));
        const remaining = Math.min(total, Math.max(0, Math.trunc(parsedRemaining)));
        const used = total - remaining;
        const settingsCountText = `${used} used · ${remaining} remaining of ${total}`;
        let tone = null;
        let settingsStatusText = `${settingsCountText}. Each code works once.`;
        let alert = null;

        if (remaining === 0) {
            tone = 'danger';
            settingsStatusText = `${settingsCountText}. Generate a fresh set now.`;
            alert = {
                level: 'critical',
                remaining,
                title: 'No recovery codes remain',
                message: 'Recovery-code sign-in is unavailable until you generate and save a fresh set.'
            };
        } else if (remaining <= 2) {
            tone = 'warning';
            settingsStatusText = `${settingsCountText}. Generate a fresh set soon.`;
            alert = {
                level: 'warning',
                remaining,
                title: 'Recovery codes are running low',
                message: `${remaining} one-time recovery code${remaining === 1 ? '' : 's'} remain${remaining === 1 ? 's' : ''}. Generate a fresh set before you need emergency access.`
            };
        }

        return {
            valid: true,
            total,
            remaining,
            used,
            tone,
            settingsCountText,
            settingsStatusText,
            alert
        };
    }

    function renderRecoveryCodeSurfaces(documentRef, remaining, total) {
        const view = createRecoveryCodeView(remaining, total);
        if (!documentRef || typeof documentRef.getElementById !== 'function') return view;
        if (!view.valid) {
            hideRecoveryCodeDashboardAlert(documentRef);
            return view;
        }

        const status = documentRef.getElementById('recovery-code-status');
        const count = documentRef.getElementById('recovery-code-remaining');
        if (count) count.textContent = view.settingsCountText;
        if (status) {
            status.textContent = view.settingsStatusText;
            status.removeAttribute('data-tone');
            if (view.tone) status.setAttribute('data-tone', view.tone);
        }

        if (!view.alert) {
            hideRecoveryCodeDashboardAlert(documentRef);
            return view;
        }

        const dashboardAlert = documentRef.getElementById('dashboard-recovery-alert');
        const alertTitle = documentRef.getElementById('dashboard-recovery-alert-title');
        const alertMessage = documentRef.getElementById('dashboard-recovery-alert-message');
        if (alertTitle) alertTitle.textContent = view.alert.title;
        if (alertMessage) alertMessage.textContent = view.alert.message;
        if (dashboardAlert) {
            dashboardAlert.dataset.level = view.alert.level;
            dashboardAlert.hidden = false;
        }
        return view;
    }

    return {
        createRecoveryCodeView,
        renderRecoveryCodeSurfaces,
        hideRecoveryCodeDashboardAlert
    };
});
