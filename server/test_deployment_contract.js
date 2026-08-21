// Focused deployment contract checks for direct signal delivery in production.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const railway = JSON.parse(fs.readFileSync(path.join(projectRoot, 'railway.json'), 'utf8'));
const dockerfile = fs.readFileSync(path.join(projectRoot, 'Dockerfile'), 'utf8');
let passed = 0;

function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  PASS  ${name}`);
    } catch (error) {
        console.error(`  FAIL  ${name} — ${error.message}`);
        throw error;
    }
}

check('Railway launches the storage-aware Node bootstrap directly', () => {
    assert.strictEqual(railway.deploy.startCommand, 'node server/start_server.js');
});

check('Railway reserves a string-valued 15-second drain window', () => {
    assert.strictEqual(typeof railway.deploy.drainingSeconds, 'string');
    assert.strictEqual(railway.deploy.drainingSeconds, '15');
});

check('Railway does not attempt volume restoration during pre-deploy', () => {
    assert.strictEqual(railway.deploy.preDeployCommand, undefined);
});

check('the runtime container launches the storage-aware Node bootstrap directly', () => {
    const command = dockerfile.match(/^CMD\s+(\[[^\r\n]+\])\s*$/m);
    assert.ok(command, 'Dockerfile must contain a JSON-array CMD');
    assert.deepStrictEqual(JSON.parse(command[1]), ['node', 'server/start_server.js']);
});

console.log(`\n${passed} passed, 0 failed`);
