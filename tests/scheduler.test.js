const assert = require('assert');
const Module = require('module');

const configurationState = new Map([
    ['auto-accept.schedule', new Map([
        ['enabled', true],
        ['mode', 'queue'],
        ['value', '5'],
        ['prompt', 'Custom prompt'],
        ['prompts', ['a', 'b']],
        ['queueMode', 'loop'],
        ['silenceTimeout', 99],
        ['checkPrompt.enabled', true],
        ['checkPrompt.text', 'Custom check']
    ])],
    ['auto-accept.antigravityQuota', new Map([
        ['enabled', false],
        ['pollInterval', 120]
    ])],
    ['auto-accept.antigravityQuota.resume', new Map([
        ['enabled', false]
    ])],
    ['auto-accept.autoContinue', new Map([
        ['enabled', true]
    ])],
    ['auto-accept.debugMode', new Map([
        ['enabled', true]
    ])],
    ['auto-accept', new Map([
        ['cdpPort', 9999]
    ])]
]);

const updateLog = [];

const vscodeStub = {
    ConfigurationTarget: { Global: 'global' },
    workspace: {
        getConfiguration(section) {
            if (!configurationState.has(section)) {
                configurationState.set(section, new Map());
            }
            const store = configurationState.get(section);
            return {
                get(key, fallback) {
                    return store.has(key) ? store.get(key) : fallback;
                },
                async update(key, value) {
                    updateLog.push({ section, key, value });
                    store.set(key, value);
                }
            };
        }
    },
    window: {
        showWarningMessage() {},
        showErrorMessage() {},
        showInformationMessage() {},
        createWebviewPanel() {
            throw new Error('not needed in test');
        }
    },
    commands: {
        async executeCommand() {
            return undefined;
        },
        async getCommands() {
            return [];
        }
    },
    env: {
        appName: 'Antigravity',
        machineId: 'test-machine'
    }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.call(this, request, parent, isMain);
};

const { DebugHandler } = require('../main_scripts/debug-handler');
const { __testables } = require('../main_scripts/extension-impl');

async function run() {
    const context = {
        globalState: {
            values: new Map([
                ['auto-accept-enabled-global', true],
                ['auto-accept-frequency', 500],
                ['auto-accept-banned-commands', ['rm -rf']],
                ['auto-accept-roi-stats', { clicksThisWeek: 1 }]
            ]),
            get(key, fallback) {
                return this.values.has(key) ? this.values.get(key) : fallback;
            },
            async update(key, value) {
                this.values.set(key, value);
            }
        }
    };

    const connectedClient = { isConnected: () => true };
    const disconnectedClient = { isConnected: () => false };

    const debugHandlerConnected = new DebugHandler(context, {
        getAntigravityClient: () => connectedClient,
        getLockedOut: () => false
    });
    const debugHandlerDisconnected = new DebugHandler(context, {
        getAntigravityClient: () => disconnectedClient,
        getLockedOut: () => false
    });

    const connectedStatus = await debugHandlerConnected.handleCommand('getAntigravityStatus');
    assert.equal(connectedStatus.status, 'connected', 'method-based client should report connected');

    const disconnectedStatus = await debugHandlerDisconnected.handleCommand('getAntigravityStatus');
    assert.equal(disconnectedStatus.status, 'disconnected', 'method-based client should report disconnected');

    const fullState = debugHandlerDisconnected.getFullState();
    assert.equal(fullState.state.antigravityStatus, 'disconnected', 'full state should use connection method result');

    await __testables.resetExtensionSettings(context);

    assert.equal(context.globalState.get('auto-accept-enabled-global'), false);
    assert.equal(context.globalState.get('auto-accept-frequency'), 1000);
    assert.equal(context.globalState.get('auto-accept-banned-commands'), undefined);
    assert.equal(context.globalState.get('auto-accept-roi-stats'), undefined);

    assert.equal(vscodeStub.workspace.getConfiguration('auto-accept.schedule').get('enabled'), false);
    assert.deepEqual(vscodeStub.workspace.getConfiguration('auto-accept.schedule').get('prompts'), []);
    assert.equal(vscodeStub.workspace.getConfiguration('auto-accept.antigravityQuota').get('enabled'), true);
    assert.equal(vscodeStub.workspace.getConfiguration('auto-accept.antigravityQuota.resume').get('enabled'), true);
    assert.equal(vscodeStub.workspace.getConfiguration('auto-accept.autoContinue').get('enabled'), false);
    assert.equal(vscodeStub.workspace.getConfiguration('auto-accept.debugMode').get('enabled'), false);
    assert.equal(vscodeStub.workspace.getConfiguration('auto-accept').get('cdpPort'), 0);

    assert(
        updateLog.some((entry) => entry.section === 'auto-accept.schedule' && entry.key === 'prompts'),
        'reset should write back schedule prompt queue'
    );
}

run()
    .then(() => {
        console.log('scheduler.test.js passed');
    })
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => {
        Module._load = originalLoad;
    });
