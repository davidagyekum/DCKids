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

check('Railway launches server.js with Node directly', () => {
    assert.strictEqual(railway.deploy.startCommand, 'node server/server.js');
});

check('Railway reserves a string-valued 15-second drain window', () => {
    assert.strictEqual(typeof railway.deploy.drainingSeconds, 'string');
    assert.strictEqual(railway.deploy.drainingSeconds, '15');
});

check('Railway restores a one-time cutover seed before starting the server', () => {
    assert.deepStrictEqual(railway.deploy.preDeployCommand, ['node server/restore_seed.js']);
});

check('the runtime container launches server.js with Node directly', () => {
    const command = dockerfile.match(/^CMD\s+(\[[^\r\n]+\])\s*$/m);
    assert.ok(command, 'Dockerfile must contain a JSON-array CMD');
    assert.deepStrictEqual(JSON.parse(command[1]), ['node', 'server/server.js']);
});

console.log(`\n${passed} passed, 0 failed`);
