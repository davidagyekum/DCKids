'use strict';

const assert = require('assert');

let recoveryView = null;
try {
    recoveryView = require('../admin-recovery-view');
} catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes('admin-recovery-view')) throw error;
}

function requireRecoveryView() {
    assert.ok(recoveryView, 'admin-recovery-view.js must implement recovery-code visibility states');
    return recoveryView;
}

function makeElement() {
    return {
        hidden: false,
        textContent: '',
        dataset: {},
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = String(value); },
        removeAttribute(name) { delete this.attributes[name]; }
    };
}

function makeDocument() {
    const elements = {
        'recovery-code-status': makeElement(),
        'recovery-code-remaining': makeElement(),
        'dashboard-recovery-alert': makeElement(),
        'dashboard-recovery-alert-title': makeElement(),
        'dashboard-recovery-alert-message': makeElement()
    };
    return {
        elements,
        getElementById(id) { return elements[id] || null; }
    };
}

function testSafeStateShowsUsageWithoutDashboardAlert() {
    const { createRecoveryCodeView } = requireRecoveryView();
    const view = createRecoveryCodeView(8, 8);

    assert.strictEqual(view.valid, true);
    assert.strictEqual(view.used, 0);
    assert.strictEqual(view.remaining, 8);
    assert.strictEqual(view.settingsCountText, '0 used · 8 remaining of 8');
    assert.strictEqual(view.alert, null);
}

function testLowStatesExposeActionableWarning() {
    const { createRecoveryCodeView } = requireRecoveryView();
    const twoRemaining = createRecoveryCodeView(2, 8);
    const oneRemaining = createRecoveryCodeView(1, 8);

    assert.strictEqual(twoRemaining.used, 6);
    assert.strictEqual(twoRemaining.alert.level, 'warning');
    assert.strictEqual(twoRemaining.alert.remaining, 2);
    assert.strictEqual(oneRemaining.settingsCountText, '7 used · 1 remaining of 8');
    assert.strictEqual(oneRemaining.alert.level, 'warning');
    assert.strictEqual(oneRemaining.alert.remaining, 1);
    assert.match(oneRemaining.alert.message, /^1 one-time recovery code remains\./);
}

function testEmptyStateIsCritical() {
    const { createRecoveryCodeView } = requireRecoveryView();
    const view = createRecoveryCodeView(0, 8);

    assert.strictEqual(view.settingsCountText, '8 used · 0 remaining of 8');
    assert.strictEqual(view.alert.level, 'critical');
    assert.strictEqual(view.alert.remaining, 0);
}

function testInvalidStateCannotLeaveAStaleDashboardWarning() {
    const { renderRecoveryCodeSurfaces, hideRecoveryCodeDashboardAlert } = requireRecoveryView();
    const document = makeDocument();

    renderRecoveryCodeSurfaces(document, 2, 8);
    assert.strictEqual(document.elements['dashboard-recovery-alert'].hidden, false);
    assert.strictEqual(document.elements['dashboard-recovery-alert'].dataset.level, 'warning');

    const view = renderRecoveryCodeSurfaces(document, undefined, 8);
    assert.strictEqual(view.valid, false);
    assert.strictEqual(document.elements['dashboard-recovery-alert'].hidden, true);
    assert.strictEqual(document.elements['dashboard-recovery-alert'].dataset.level, undefined);

    renderRecoveryCodeSurfaces(document, 0, 8);
    hideRecoveryCodeDashboardAlert(document);
    assert.strictEqual(document.elements['dashboard-recovery-alert'].hidden, true);
    assert.strictEqual(document.elements['dashboard-recovery-alert-title'].textContent, '');
    assert.strictEqual(document.elements['dashboard-recovery-alert-message'].textContent, '');
}

function testRenderingSynchronizesSettingsAndDashboard() {
    const { renderRecoveryCodeSurfaces } = requireRecoveryView();
    const document = makeDocument();

    renderRecoveryCodeSurfaces(document, 2, 8);
    assert.strictEqual(document.elements['recovery-code-remaining'].textContent, '6 used · 2 remaining of 8');
    assert.strictEqual(document.elements['recovery-code-status'].attributes['data-tone'], 'warning');
    assert.strictEqual(document.elements['dashboard-recovery-alert'].hidden, false);

    renderRecoveryCodeSurfaces(document, 8, 8);
    assert.strictEqual(document.elements['recovery-code-remaining'].textContent, '0 used · 8 remaining of 8');
    assert.strictEqual(document.elements['recovery-code-status'].attributes['data-tone'], undefined);
    assert.strictEqual(document.elements['dashboard-recovery-alert'].hidden, true);
}

function testAlertContentExistsBeforeLiveRegionIsRevealed() {
    const { renderRecoveryCodeSurfaces } = requireRecoveryView();
    const document = makeDocument();
    const alert = document.elements['dashboard-recovery-alert'];
    let hidden = true;
    let titleWhenRevealed = null;
    Object.defineProperty(alert, 'hidden', {
        configurable: true,
        get() { return hidden; },
        set(value) {
            hidden = value;
            if (value === false) {
                titleWhenRevealed = document.elements['dashboard-recovery-alert-title'].textContent;
            }
        }
    });

    renderRecoveryCodeSurfaces(document, 2, 8);
    assert.strictEqual(titleWhenRevealed, 'Recovery codes are running low');
}

const tests = [
    testSafeStateShowsUsageWithoutDashboardAlert,
    testLowStatesExposeActionableWarning,
    testEmptyStateIsCritical,
    testInvalidStateCannotLeaveAStaleDashboardWarning,
    testRenderingSynchronizesSettingsAndDashboard,
    testAlertContentExistsBeforeLiveRegionIsRevealed
];

for (const test of tests) {
    test();
    console.log(`PASS  ${test.name}`);
}
console.log(`\n${tests.length} admin recovery-view tests passed`);
