// Flat ESLint config for the whole repo. Two worlds:
//  - server/  : CommonJS Node code — full recommended rules, errors block CI.
//  - root *.js: browser scripts loaded via <script> tags that share globals
//    across files. Cross-file rules (no-undef/no-unused-vars) would drown real
//    findings in false positives, and legacy patterns (var redeclares,
//    intentional function wrapping) predate this config — those are warnings,
//    so CI surfaces them without blocking. New hard breakage (parse errors,
//    dupe keys, const reassignment) still fails the build.
// The only package.json lives in server/, so resolve the plugin from there.
const js = require('./server/node_modules/@eslint/js');

module.exports = [
    {
        ignores: [
            '**/node_modules/**',
            'server/backups/**',
            'images/**',
            'docs/**',
            '.claude/**',
            '_backup_pre_import*/**',
            '_frontend_backup_*/**',
            'dc kids (1)/**',
            '**/*.min.js'
        ]
    },
    {
        files: ['server/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly', module: 'writable', exports: 'writable',
                process: 'readonly', console: 'readonly', __dirname: 'readonly',
                Buffer: 'readonly', setTimeout: 'readonly', setInterval: 'readonly',
                clearTimeout: 'readonly', clearInterval: 'readonly',
                fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', Promise: 'readonly'
            }
        },
        rules: {
            ...js.configs.recommended.rules,
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }]
        }
    },
    {
        files: ['*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script'
        },
        rules: {
            ...js.configs.recommended.rules,
            'no-undef': 'off',
            'no-unused-vars': 'off',
            // Legacy-pattern noise in the pre-config codebase: surface, don't block.
            'no-empty': 'warn',
            'no-redeclare': 'warn',
            'no-func-assign': 'warn',
            'no-unreachable': 'warn',
            'no-useless-assignment': 'warn',
            'no-prototype-builtins': 'warn',
            'no-useless-escape': 'warn'
        }
    }
];
