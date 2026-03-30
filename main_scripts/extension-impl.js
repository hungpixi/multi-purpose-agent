const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { DebugHandler } = require('./debug-handler');


// Lazy load SettingsPanel to avoid blocking activation
let SettingsPanel = null;
function getSettingsPanel() {
    if (!SettingsPanel) {
        try {
            SettingsPanel = require('./settings-panel').SettingsPanel;
        } catch (e) {
            console.error('Failed to load SettingsPanel:', e);
        }
    }
    return SettingsPanel;
}

// Lazy load AntigravityClient for direct backend connection
let AntigravityClient = null;
let antigravityClient = null;
function getAntigravityClient() {
    if (!AntigravityClient) {
        try {
            AntigravityClient = require('./antigravity/client').AntigravityClient;
        } catch (e) {
            console.error('Failed to load AntigravityClient:', e);
        }
    }
    return AntigravityClient;
}

// states

const GLOBAL_STATE_KEY = 'antigravity-mpa-enabled-global';
const FREQ_STATE_KEY = 'antigravity-mpa-frequency';
const BANNED_COMMANDS_KEY = 'antigravity-mpa-banned-commands';
const ROI_STATS_KEY = 'antigravity-mpa-roi-stats';
const CDP_SETUP_COMPLETED_KEY = 'cdp-setup-completed';
const EXTENSION_VERSION_KEY = 'extension-version'; // Track version to detect reinstall
const SECONDS_PER_CLICK = 5; // Conservative estimate: 5 seconds saved per antigravity-mpa

let isEnabled = false;
let isLockedOut = false; // Local tracking
let pollFrequency = 500; // Fast default (was 2000)
let bannedCommands = []; // List of command patterns to block

let pollTimer;
let statsCollectionTimer; // For periodic stats collection
let quotaPollingTimer; // For Antigravity quota polling
let statusBarItem;
let statusSettingsItem;
let statusQuotaItem; // Antigravity Quota display
let statusQueueItem; // Queue status display
let outputChannel;
let currentIDE = 'antigravity'; // 'antigravity' | 'Code'
let globalContext;

let cdpHandler;
let relauncher;
let debugHandler; // Debug Handler instance
let configuredCdpPort = 9004; // Configurable CDP port from settings
let cdpPopupShownThisSession = false; // Track if popup was shown this session
let relaunchAttemptedThisSession = false; // Track if relaunch was attempted

const extensionRoot = path.basename(__dirname).toLowerCase() === 'dist'
    ? path.join(__dirname, '..')
    : __dirname;

function formatCdpLogSuffix(d = new Date()) {
    const pad2 = (n) => String(n).padStart(2, '0');
    const mm = pad2(d.getMinutes());
    const hh = pad2(d.getHours());
    const dd = pad2(d.getDate());
    const MM = pad2(d.getMonth() + 1);
    const yy = pad2(d.getFullYear() % 100);
    return `${mm}${hh}-${dd}${MM}${yy}`;
}

const cdpLogPath = path.join(extensionRoot, `multi-purpose-cdp-${formatCdpLogSuffix()}.log`);

function log(message) {
    try {
        const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
        const logLine = `[${timestamp}] ${message}`;
        console.log(logLine);

        // Write to log file for debug mode
        fs.appendFileSync(cdpLogPath, logLine + '\n');
    } catch (e) {
        console.error('\u{26A1} failed:', e);
    }
}

const { Scheduler } = require('./scheduler');

let scheduler;

function detectIDE() {
    const appName = vscode.env.appName || '';
    if (appName.toLowerCase().includes('antigravity')) return 'Antigravity';
    return 'Code'; // VS Code base
}

/**
 * Auto-fix CDP connection instead of showing popup.
 * Attempts silent relaunch with --remote-debugging-port=0 if discovery fails.
 */
async function autoFixCDP() {
    if (cdpPopupShownThisSession) return false;

    log('Auto-fixing CDP connection...');

    // Step 1: Try auto-discovery (cdp-handler now does this internally)
    if (cdpHandler) {
        const available = await cdpHandler.isCDPAvailable();
        if (available) {
            const activePort = cdpHandler.getActivePort();
            log(`CDP auto-fix SUCCESS: found on port ${activePort}`);
            configuredCdpPort = activePort;
            return true;
        }
    }

    // Step 2: Silent relaunch with --remote-debugging-port=0
    if (relauncher && !relaunchAttemptedThisSession) {
        log('CDP not found. Attempting silent relaunch...');
        relaunchAttemptedThisSession = true;
        const result = await relauncher.silentRelaunch();
        if (result) return true;
    }

    // Step 3: If all fails, show a minimal non-modal notification (NOT the old scary popup)
    if (!cdpPopupShownThisSession) {
        cdpPopupShownThisSession = true;
        vscode.window.showInformationMessage(
            'Antigravity Multi Purpose Agent: CDP auto-connect failed. Will retry automatically.',
            'Retry Now'
        ).then(choice => {
            if (choice === 'Retry Now' && cdpHandler) {
                cdpHandler.isCDPAvailable().then(ok => {
                    if (ok) vscode.window.showInformationMessage('Antigravity Multi Purpose Agent: Connected!');
                });
            }
        });
    }

    return false;
}

async function activate(context) {
    globalContext = context;
    console.log('Multi Purpose Extension: Activator called.');

    // CRITICAL: Create status bar items FIRST before anything else
    try {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.command = 'antigravity-mpa.toggle';
        statusBarItem.text = '\u{23F3} Multi Purpose: Loading...';
        statusBarItem.tooltip = 'Antigravity Multi Purpose Agent is initializing...';
        context.subscriptions.push(statusBarItem);
        statusBarItem.show();

        statusSettingsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
        statusSettingsItem.command = 'antigravity-mpa.openSettings';
        statusSettingsItem.text = '\u{2699}\u{FE0F}';
        statusSettingsItem.tooltip = 'Multi Purpose Settings';
        context.subscriptions.push(statusSettingsItem);
        statusSettingsItem.show();

        // Antigravity Quota status bar item
        statusQuotaItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
        statusQuotaItem.command = 'antigravity-mpa.openSettings';
        statusQuotaItem.text = '\u{1F4CA} Quota: --';
        statusQuotaItem.tooltip = 'Antigravity Quota - Click to open settings';
        context.subscriptions.push(statusQuotaItem);
        // Show based on config setting

        // Queue Status bar item
        statusQueueItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 96);
        statusQueueItem.command = 'antigravity-mpa.showQueueMenu';
        statusQueueItem.text = '\u{1F4CB} Queue: Idle';
        statusQueueItem.tooltip = 'Prompt Queue - Click for controls';
        context.subscriptions.push(statusQueueItem);
        // Hidden by default, shown when queue is running

        console.log('Antigravity Multi Purpose: Status bar items created and shown.');
    } catch (sbError) {
        console.error('CRITICAL: Failed to create status bar items:', sbError);
    }

    try {
        // 1. Initialize State
        isEnabled = context.workspaceState.get(GLOBAL_STATE_KEY, false);

        // Load frequency
        pollFrequency = context.workspaceState.get(FREQ_STATE_KEY, 1000);

        // Load banned commands list (default: common dangerous patterns)
        const defaultBannedCommands = [
            'rm -rf /',
            'rm -rf ~',
            'rm -rf *',
            'format c:',
            'del /f /s /q',
            'rmdir /s /q',
            ':(){:|:&};:',  // fork bomb
            'dd if=',
            'mkfs.',
            '> /dev/sda',
            'chmod -R 777 /'
        ];
        bannedCommands = context.workspaceState.get(BANNED_COMMANDS_KEY, defaultBannedCommands);

        currentIDE = detectIDE();

        // 2. Create Output Channel
        outputChannel = vscode.window.createOutputChannel('Antigravity Multi Purpose Agent');
        context.subscriptions.push(outputChannel);

        log(`Multi Purpose: Activating...`);
        log(`Multi Purpose: Detected environment: ${currentIDE.toUpperCase()}`);

        // Setup Focus Listener - Push state to browser (authoritative source)
        vscode.window.onDidChangeWindowState(async (e) => {
            // Always push focus state to browser - this is the authoritative source
            if (cdpHandler && cdpHandler.setFocusState) {
                await cdpHandler.setFocusState(e.focused);
            }

            // When user returns and antigravity-mpa is running, check for away actions
            if (e.focused && isEnabled) {
                log(`[Away] Window focus detected by VS Code API. Checking for away actions...`);
                // Wait a tiny bit for CDP to settle after focus state is pushed
                setTimeout(() => checkForAwayActions(context), 500);
            }
        });

        // 3. Initialize Handlers (Lazy Load) - 🤖h IDEs use CDP now
        try {
            const { CDPHandler } = require('./cdp-handler');
            const { Relauncher } = require('./relauncher');

            // Read configured CDP port from settings
            configuredCdpPort = vscode.workspace.getConfiguration('antigravity-mpa').get('cdpPort', 9004);
            log(`Configured CDP port: ${configuredCdpPort}`);

            cdpHandler = new CDPHandler(log, configuredCdpPort);
            relauncher = new Relauncher(log, configuredCdpPort);
            log(`CDP handlers initialized for ${currentIDE}.`);



            // CRITICAL: Start CDP connections immediately to establish browser communication
            // This connects to the configured CDP port and injects the browser script
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const detectedWorkspace = workspaceFolders && workspaceFolders.length > 0
                ? workspaceFolders[0].name
                : null;

            const cdpConfig = {
                ide: currentIDE,
                bannedCommands: context.workspaceState.get(BANNED_COMMANDS_KEY, []),
                pollInterval: context.workspaceState.get(FREQ_STATE_KEY, 1000),
                workspaceName: detectedWorkspace,
                port: configuredCdpPort
            };
            cdpHandler.start(cdpConfig).then(() => {
                log(`CDP connections established. Active connections: ${cdpHandler.getConnectionCount()}`);
            }).catch(e => {
                log(`CDP start warning: ${e.message}`);
            });

            // Initialize Scheduler
            scheduler = new Scheduler(context, cdpHandler, log, { ensureCdpReady: syncSessions });
            scheduler.start();

            debugHandler = new DebugHandler(context, {
                log,
                getScheduler: () => scheduler,
                getAntigravityClient: () => antigravityClient,
                getLockedOut: () => isLockedOut,
                getCDPHandler: () => cdpHandler,
                getRelauncher: () => relauncher,
                syncSessions: async () => syncSessions()
            });
            debugHandler.startServer();
        } catch (err) {
            log(`Failed to initialize CDP handlers: ${err.message}`);
            vscode.window.showErrorMessage(`Multi Purpose Error: ${err.message}`);
        }

        // 3.5 Initialize Antigravity Client and Quota Display
        const quotaConfig = vscode.workspace.getConfiguration('antigravity-mpa.antigravityQuota');
        const quotaEnabled = quotaConfig.get('enabled', true);
        const quotaPollInterval = quotaConfig.get('pollInterval', 60) * 1000; // Convert to ms

        if (quotaEnabled) {
            // Show quota status bar
            if (statusQuotaItem) {
                statusQuotaItem.show();
            }

            // Initialize and start quota polling (works for all IDEs, not just Antigravity)
            initAntigravityClient().then(connected => {
                if (connected) {
                    log('[Antigravity] Connected to language server, starting quota polling');
                    startQuotaPolling(quotaPollInterval);
                } else {
                    log('[Antigravity] Could not connect to language server');
                    updateQuotaStatusBar('N/A', 'Antigravity not detected');
                }
            }).catch(e => {
                log(`[Antigravity] Init error (non-critical): ${e.message}`);
                updateQuotaStatusBar('N/A', 'Connection error');
            });
        } else {
            log('[Antigravity] Quota display disabled in settings');
            if (statusQuotaItem) {
                statusQuotaItem.hide();
            }
        }

        // 4. Update Status Bar (already created at start)
        updateStatusBar();
        log('Status bar updated with current state.');

        // 5. Register Commands
        context.subscriptions.push(
            vscode.commands.registerCommand('antigravity-mpa.toggle', () => handleToggle(context)),
            vscode.commands.registerCommand('antigravity-mpa.relaunch', () => handleRelaunch()),
            vscode.commands.registerCommand('antigravity-mpa.updateFrequency', (freq) => handleFrequencyUpdate(context, freq)),
            vscode.commands.registerCommand('antigravity-mpa.updateBannedCommands', (commands) => handleBannedCommandsUpdate(context, commands)),
            vscode.commands.registerCommand('antigravity-mpa.getBannedCommands', () => bannedCommands),
            vscode.commands.registerCommand('antigravity-mpa.getROIStats', async () => {
                const stats = await loadROIStats(context);
                const timeSavedSeconds = stats.clicksThisWeek * SECONDS_PER_CLICK;
                const timeSavedMinutes = Math.round(timeSavedSeconds / 60);
                return {
                    ...stats,
                    timeSavedMinutes,
                    timeSavedFormatted: timeSavedMinutes >= 60
                        ? `${(timeSavedMinutes / 60).toFixed(1)} hours`
                        : `${timeSavedMinutes} minutes`
                };
            }),
            vscode.commands.registerCommand('antigravity-mpa.openSettings', () => {
                const panel = getSettingsPanel();
                if (panel) {
                    panel.createOrShow(context.extensionUri, context);
                } else {
                    vscode.window.showErrorMessage('Failed to load Settings Panel.');
                }
            }),
            vscode.commands.registerCommand('antigravity-mpa.checkAntigravityStatus', () => handleCheckAntigravityStatus()),
            vscode.commands.registerCommand('antigravity-mpa.getAntigravityQuota', () => handleGetAntigravityQuota()),
            vscode.commands.registerCommand('antigravity-mpa.toggleAntigravityQuota', (value) => handleToggleAntigravityQuota(value)),
            vscode.commands.registerCommand('antigravity-mpa.getAntigravityQuotaEnabled', () => {
                const config = vscode.workspace.getConfiguration('antigravity-mpa.antigravityQuota');
                return config.get('enabled', true);
            }),
            vscode.commands.registerCommand('antigravity-mpa.startQueue', async (options) => {
                log('[Scheduler] Queue start requested via command');
                if (scheduler) {
                    // Ensure CDP connects/injects the active chat surface before starting the queue.
                    await syncSessions();
                    await scheduler.startQueue(options);
                    log('[Scheduler] Queue start handled via command');
                } else {
                    log('[Scheduler] Cannot start queue - scheduler not initialized');
                    vscode.window.showWarningMessage('Antigravity Multi Purpose: Scheduler not ready. Please try again.');
                }
            }),
            vscode.commands.registerCommand('antigravity-mpa.getQueueStatus', () => {
                if (scheduler) {
                    return scheduler.getStatus();
                }
                return { enabled: false, isRunningQueue: false, queueLength: 0, queueIndex: 0, isQuotaExhausted: false };
            }),
            vscode.commands.registerCommand('antigravity-mpa.getConversations', async () => {
                if (scheduler) {
                    return await scheduler.getConversations();
                }
                return [];
            }),
            vscode.commands.registerCommand('antigravity-mpa.getPromptHistory', () => {
                if (scheduler) {
                    return scheduler.getHistory();
                }
                return [];
            }),
            vscode.commands.registerCommand('antigravity-mpa.setTargetConversation', (conversationId) => {
                if (scheduler) {
                    scheduler.setTargetConversation(conversationId);
                }
            }),
            vscode.commands.registerCommand('antigravity-mpa.pauseQueue', () => {
                if (scheduler) {
                    scheduler.pauseQueue();
                }
            }),
            vscode.commands.registerCommand('antigravity-mpa.resumeQueue', () => {
                if (scheduler) {
                    scheduler.resumeQueue();
                }
            }),
            vscode.commands.registerCommand('antigravity-mpa.skipPrompt', async () => {
                if (scheduler) {
                    await scheduler.skipPrompt();
                }
            }),
            vscode.commands.registerCommand('antigravity-mpa.stopQueue', () => {
                if (scheduler) {
                    scheduler.stopQueue();
                }
            }),
            vscode.commands.registerCommand('antigravity-mpa.showQueueMenu', async () => {
                if (!scheduler) return;

                const status = scheduler.getStatus();
                const items = [];

                if (status.isRunningQueue) {
                    if (status.isPaused) {
                        items.push({ label: '\u{25B6}\u{FE0F} Resume', action: 'resume' });
                    } else {
                        items.push({ label: '\u{23F8}\u{FE0F} Pause', action: 'pause' });
                    }
                    items.push({ label: '\u{23ED}\u{FE0F} Skip Current', action: 'skip' });
                    items.push({ label: '\u{23F9}\u{FE0F} Stop Queue', action: 'stop' });
                }
                items.push({ label: '\u{2699}\u{FE0F} Open Settings', action: 'settings' });

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: `Queue: ${status.queueIndex + 1}/${status.queueLength}${status.isPaused ? ' (Paused)' : ''}`
                });

                if (selected) {
                    switch (selected.action) {
                        case 'pause': scheduler.pauseQueue(); break;
                        case 'resume': scheduler.resumeQueue(); break;
                        case 'skip': await scheduler.skipPrompt(); break;
                        case 'stop': scheduler.stopQueue(); break;
                        case 'settings': vscode.commands.executeCommand('antigravity-mpa.openSettings'); break;
                    }
                }
            }),
            vscode.commands.registerCommand('antigravity-mpa.resetSettings', async () => {
                // Reset all extension settings
                await context.workspaceState.update(GLOBAL_STATE_KEY, false);
                await context.workspaceState.update(FREQ_STATE_KEY, 1000);
                await context.workspaceState.update(BANNED_COMMANDS_KEY, undefined);
                await context.workspaceState.update(ROI_STATS_KEY, undefined);
                isEnabled = false;
                bannedCommands = [];
                vscode.window.showInformationMessage('Antigravity Multi Purpose: All settings reset to defaults.');
                updateStatusBar();
            }),
            // Debug Mode Command - Allows AI agent programmatic control
            vscode.commands.registerCommand('antigravity-mpa.debugCommand', async (action, params = {}) => {
                if (debugHandler) {
                    return await debugHandler.handleCommand(action, params);
                }
                return { success: false, error: 'DebugHandler not ready' };
            })
        );

        // Monitor configuration changes for Debug Mode
        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('antigravity-mpa.debugMode.enabled') && debugHandler) {
                const enabled = vscode.workspace.getConfiguration('antigravity-mpa.debugMode').get('enabled', false);
                if (enabled) {
                    debugHandler.startServer();
                } else {
                    debugHandler.stopServer();
                }
            }
        }));


        // 7. Check environment and start if enabled
        try {
            await checkEnvironmentAndStart();
        } catch (err) {
            log(`Error in environment check: ${err.message}`);
        }

        log('Antigravity Multi Purpose: Activation complete');
    } catch (error) {
        console.error('ACTIVATION CRITICAL FAILURE:', error);
        log(`ACTIVATION CRITICAL FAILURE: ${error.message}`);
        vscode.window.showErrorMessage(`Multi Purpose Extension failed to activate: ${error.message}`);
    }
}

async function ensureCDPOrPrompt(showPrompt = false) {
    if (!cdpHandler) return false;

    log('Checking for active CDP session (with auto-discovery)...');
    const cdpAvailable = await cdpHandler.isCDPAvailable();
    log(`Environment check: CDP Available = ${cdpAvailable}`);

    if (cdpAvailable) {
        // Update configured port if auto-discovered
        const activePort = cdpHandler.getActivePort();
        if (activePort !== configuredCdpPort) {
            log(`CDP port auto-updated: ${configuredCdpPort} → ${activePort}`);
            configuredCdpPort = activePort;
        }
        log('CDP is active and available.');
        return true;
    } else {
        log(`CDP not found. Attempting auto-fix...`);
        if (showPrompt) {
            return await autoFixCDP();
        }
        return false;
    }
}

async function checkEnvironmentAndStart() {
    const vscode = require('vscode');
    // Support both original and forked extension IDs
    const ext = vscode.extensions.getExtension('hungpixi.hungpixi-multi-purpose-agent');
    const currentVersion = ext?.packageJSON?.version || '0.0.0';
    const storedVersion = globalContext.globalState.get(EXTENSION_VERSION_KEY, null);

    // Detect fresh install or reinstall (version changed)
    const isNewInstall = storedVersion === null;
    const isReinstall = storedVersion !== null && storedVersion !== currentVersion;

    if (isNewInstall || isReinstall) {
        log(`${isReinstall ? 'Reinstall' : 'New install'} detected (${storedVersion} → ${currentVersion}). Resetting CDP setup state.`);
        await globalContext.globalState.update(CDP_SETUP_COMPLETED_KEY, false);
        await globalContext.globalState.update(EXTENSION_VERSION_KEY, currentVersion);
    }

    // Auto-discovery: try to find CDP silently (NO popup, NO restart prompt)
    const cdpAvailable = cdpHandler ? await cdpHandler.isCDPAvailable() : false;

    if (cdpAvailable) {
        log('CDP auto-discovered successfully.');
        await globalContext.globalState.update(CDP_SETUP_COMPLETED_KEY, true);
        
        // Update port if auto-discovered a different one
        const activePort = cdpHandler.getActivePort();
        if (activePort !== configuredCdpPort) {
            log(`CDP port auto-updated: ${configuredCdpPort} → ${activePort}`);
            configuredCdpPort = activePort;
        }
    } else {
        log('CDP not available at startup. Will auto-fix on first toggle or retry in background.');
        // Background retry: try auto-fix after a short delay (Antigravity might still be initializing)
        setTimeout(async () => {
            const retryAvailable = cdpHandler ? await cdpHandler.isCDPAvailable() : false;
            if (retryAvailable) {
                log('Background retry: CDP now available!');
                await globalContext.globalState.update(CDP_SETUP_COMPLETED_KEY, true);
                if (isEnabled) {
                    await startPolling();
                    startStatsCollection(globalContext);
                }
                updateStatusBar();
            } else if (relauncher) {
                // One silent relaunch attempt
                log('Background retry failed. Attempting silent relaunch...');
                await autoFixCDP();
            }
        }, 5000);
    }

    // Normal startup: if extension was enabled and CDP available, restore state
    if (isEnabled) {
        log('Initializing Multi Purpose environment...');
        if (!cdpAvailable) {
            log('Multi Purpose was enabled but CDP not yet available. Will retry when CDP connects.');
            // DON'T reset to OFF — let background retry handle it
        } else {
            await startPolling();
            startStatsCollection(globalContext);
        }
    }
    updateStatusBar();
}

async function handleToggle(context) {
    log('=== handleToggle CALLED ===');
    log(`  Previous isEnabled: ${isEnabled}`);

    try {
        // Auto-discovery: try to find CDP automatically (no popup, no relaunch prompt)
        const cdpAvailable = cdpHandler ? await cdpHandler.isCDPAvailable() : false;

        // If trying to enable but CDP not available, attempt auto-fix silently
        if (!isEnabled && !cdpAvailable) {
            log('Antigravity Multi Purpose: CDP not available. Attempting auto-fix...');
            const fixed = await autoFixCDP();
            if (!fixed) {
                log('Antigravity Multi Purpose: Auto-fix could not connect. Toggle will proceed anyway (retries in background).');
                // Don't block — let user toggle ON, we'll retry in background
            }
        }

        isEnabled = !isEnabled;
        log(`  New isEnabled: ${isEnabled}`);

        // Update state and UI IMMEDIATELY (non-blocking)
        await context.workspaceState.update(GLOBAL_STATE_KEY, isEnabled);
        log(`  GlobalState updated`);

        log('  Calling updateStatusBar...');
        updateStatusBar();

        // Do CDP operations in background (don't block toggle)
        if (isEnabled) {
            log('Antigravity Multi Purpose: Enabled');
            // These operations happen in background
            ensureCDPOrPrompt(true).then(() => startPolling());
            startStatsCollection(context);
            incrementSessionCount(context);
        } else {
            log('Antigravity Multi Purpose: Disabled');

            // Fire-and-forget: Show session summary notification (non-blocking)
            if (cdpHandler) {
                cdpHandler.getSessionSummary()
                    .then(summary => showSessionSummaryNotification(context, summary))
                    .catch(() => { });
            }

            // Fire-and-forget: collect stats and stop in background
            collectAndSaveStats(context).catch(() => { });
            stopPolling().catch(() => { });
        }

        log('=== handleToggle COMPLETE ===');
    } catch (e) {
        log(`Error toggling: ${e.message}`);
        log(`Error stack: ${e.stack}`);
    }
}

async function handleRelaunch() {
    if (!relauncher) {
        vscode.window.showErrorMessage('Relauncher not initialized.');
        return;
    }

    log('Initiating Relaunch sequence...');
    await relauncher.ensureCDPAndRelaunch();
}

async function handleFrequencyUpdate(context, freq) {
    pollFrequency = freq;
    await context.workspaceState.update(FREQ_STATE_KEY, freq);
    log(`Poll frequency updated to: ${freq}ms`);
    if (isEnabled) {
        await syncSessions();
    }
}

async function handleBannedCommandsUpdate(context, commands) {
    bannedCommands = Array.isArray(commands) ? commands : [];
    await context.workspaceState.update(BANNED_COMMANDS_KEY, bannedCommands);
    log(`Banned commands updated: ${bannedCommands.length} patterns`);
    if (bannedCommands.length > 0) {
        log(`Banned patterns: ${bannedCommands.slice(0, 5).join(', ')}${bannedCommands.length > 5 ? '...' : ''}`);
    }
    if (isEnabled) {
        await syncSessions();
    }
}

async function syncSessions() {
    if (cdpHandler && !isLockedOut) {
        log(`CDP: Syncing sessions...`);
        try {
            await cdpHandler.start({
                pollInterval: pollFrequency,
                ide: currentIDE,
                bannedCommands: bannedCommands
            });
        } catch (err) {
            log(`CDP: Sync error: ${err.message}`);
        }
    }
}

// Update Queue Status Bar
function updateQueueStatusBar() {
    if (!statusQueueItem || !scheduler) return;

    const status = scheduler.getStatus();

    if (status.isRunningQueue) {
        statusQueueItem.show();
        const pauseIndicator = status.isPaused ? ' \u{23F3}' : '';
        statusQueueItem.text = `\u{1F4CB} Queue ${status.queueIndex + 1}/${status.queueLength}${pauseIndicator}`;
        statusQueueItem.tooltip = status.isPaused
            ? 'Queue is paused - Click to resume'
            : `Running prompt ${status.queueIndex + 1} of ${status.queueLength} - Click for controls`;
    } else {
        statusQueueItem.hide();
    }
}

async function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    log('Antigravity Multi Purpose: Monitoring session...');

    // Initial trigger
    await syncSessions();

    // Polling now primarily handles the Instance Lock and ensures CDP is active
    pollTimer = setInterval(async () => {
        if (!isEnabled) return;

        // We are the leader or lock is dead
        

        

        await syncSessions();
    }, 5000);
}

async function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    if (statsCollectionTimer) {
        clearInterval(statsCollectionTimer);
        statsCollectionTimer = null;
    }
    if (scheduler) scheduler.stop();
    if (cdpHandler) await cdpHandler.stop();
    log('Antigravity Multi Purpose: Polling stopped');
}

// --- ROI Stats Collection ---

function getWeekStart() {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday
    const diff = now.getDate() - dayOfWeek;
    const weekStart = new Date(now.setDate(diff));
    weekStart.setHours(0, 0, 0, 0);
    return weekStart.getTime();
}

async function loadROIStats(context) {
    const defaultStats = {
        weekStart: getWeekStart(),
        clicksThisWeek: 0,
        blockedThisWeek: 0,
        sessionsThisWeek: 0
    };

    let stats = context.workspaceState.get(ROI_STATS_KEY, defaultStats);

    // Check if we need to reset for a new week
    const currentWeekStart = getWeekStart();
    if (stats.weekStart !== currentWeekStart) {
        log(`ROI Stats: New week detected. Showing summary and resetting.`);

        // Show weekly summary notification if there were meaningful stats
        if (stats.clicksThisWeek > 0) {
            await showWeeklySummaryNotification(context, stats);
        }

        // Reset for new week
        stats = { ...defaultStats, weekStart: currentWeekStart };
        await context.workspaceState.update(ROI_STATS_KEY, stats);
    }

    // Calculate formatted time for UI
    const timeSavedSeconds = (stats.clicksThisWeek || 0) * SECONDS_PER_CLICK;
    const timeSavedMinutes = Math.round(timeSavedSeconds / 60);
    let timeStr;
    if (timeSavedMinutes >= 60) {
        timeStr = `${(timeSavedMinutes / 60).toFixed(1)}h`;
    } else {
        timeStr = `${timeSavedMinutes}m`;
    }
    stats.timeSavedFormatted = timeStr;

    return stats;
}

async function showWeeklySummaryNotification(context, lastWeekStats) {
    const timeSavedSeconds = lastWeekStats.clicksThisWeek * SECONDS_PER_CLICK;
    const timeSavedMinutes = Math.round(timeSavedSeconds / 60);

    let timeStr;
    if (timeSavedMinutes >= 60) {
        timeStr = `${(timeSavedMinutes / 60).toFixed(1)} hours`;
    } else {
        timeStr = `${timeSavedMinutes} minutes`;
    }

    const message = `\u{1F4CA} Last week, Multi Purpose saved you ${timeStr} by auto-clicking ${lastWeekStats.clicksThisWeek} buttons!`;

    let detail = '';
    if (lastWeekStats.sessionsThisWeek > 0) {
        detail += `Recovered ${lastWeekStats.sessionsThisWeek} stuck sessions. `;
    }
    if (lastWeekStats.blockedThisWeek > 0) {
        detail += `Blocked ${lastWeekStats.blockedThisWeek} dangerous commands.`;
    }

    const choice = await vscode.window.showInformationMessage(
        message,
        { detail: detail.trim() || undefined },
        'View Details'
    );

    if (choice === 'View Details') {
        const panel = getSettingsPanel();
        if (panel) {
            panel.createOrShow(context.extensionUri, context);
        }
    }
}

// --- SESSION SUMMARY NOTIFICATION ---
// Called when user finishes a session (e.g., leaves conversation view)
async function showSessionSummaryNotification(context, summary) {
    log(`[Notification] showSessionSummaryNotification called with: ${JSON.stringify(summary)}`);
    if (!summary || summary.clicks === 0) {
        log(`[Notification] Session summary skipped: no clicks`);
        return;
    }
    log(`[Notification] Showing session summary for ${summary.clicks} clicks`);

    const lines = [
        `\u{1F7E2} This session:`,
        `- ${summary.clicks} actions antigravity-mpaed`,
        `- ${summary.terminalCommands} terminal commands`,
        `- ${summary.fileEdits} file edits`,
        `- ${summary.blocked} interruptions blocked`
    ];

    if (summary.estimatedTimeSaved) {
        lines.push(`\n\u{23F3} Estimated time saved: ~${summary.estimatedTimeSaved} minutes`);
    }

    const message = lines.join('\n');

    vscode.window.showInformationMessage(
        `\u{1F916} Multi Purpose: ${summary.clicks} actions handled this session`,
        { detail: message },
        'View Stats'
    ).then(choice => {
        if (choice === 'View Stats') {
            const panel = getSettingsPanel();
            if (panel) panel.createOrShow(context.extensionUri, context);
        }
    });
}

// --- "AWAY" ACTIONS NOTIFICATION ---
// Called when user returns after window was minimized/unfocused
async function showAwayActionsNotification(context, actionsCount) {
    log(`[Notification] showAwayActionsNotification called with: ${actionsCount}`);
    if (!actionsCount || actionsCount === 0) {
        log(`[Notification] Away actions skipped: count is 0 or undefined`);
        return;
    }
    log(`[Notification] Showing away actions notification for ${actionsCount} actions`);

    const message = `\u{1F680} Multi Purpose handled ${actionsCount} action${actionsCount > 1 ? 's' : ''} while you were away.`;
    const detail = `Agents stayed autonomous while you focused elsewhere.`;

    vscode.window.showInformationMessage(
        message,
        { detail },
        'View Dashboard'
    ).then(choice => {
        if (choice === 'View Dashboard') {
            const panel = getSettingsPanel();
            if (panel) panel.createOrShow(context.extensionUri, context);
        }
    });
}

// --- AWAY MODE POLLING ---
// Check for "away actions" when user returns (called periodically)
let lastAwayCheck = Date.now();
async function checkForAwayActions(context) {
    log(`[Away] checkForAwayActions called. cdpHandler=${!!cdpHandler}, isEnabled=${isEnabled}`);
    if (!cdpHandler || !isEnabled) {
        log(`[Away] Skipping check: cdpHandler=${!!cdpHandler}, isEnabled=${isEnabled}`);
        return;
    }

    try {
        log(`[Away] Calling cdpHandler.getAwayActions()...`);
        const awayActions = await cdpHandler.getAwayActions();
        log(`[Away] Got awayActions: ${awayActions}`);
        if (awayActions > 0) {
            log(`[Away] Detected ${awayActions} actions while user was away. Showing notification...`);
            await showAwayActionsNotification(context, awayActions);
        } else {
            log(`[Away] No away actions to report`);
        }
    } catch (e) {
        log(`[Away] Error checking away actions: ${e.message}`);
    }
}

async function collectAndSaveStats(context) {
    if (!cdpHandler) return;

    try {
        // Get stats from browser and reset them
        const browserStats = await cdpHandler.resetStats();

        if (browserStats.clicks > 0 || browserStats.blocked > 0) {
            const currentStats = await loadROIStats(context);
            currentStats.clicksThisWeek += browserStats.clicks;
            currentStats.blockedThisWeek += browserStats.blocked;

            await context.workspaceState.update(ROI_STATS_KEY, currentStats);
            log(`ROI Stats collected: +${browserStats.clicks} clicks, +${browserStats.blocked} blocked (Total: ${currentStats.clicksThisWeek} clicks, ${currentStats.blockedThisWeek} blocked)`);

            // Broadcast update to real-time dashboard
            const panel = getSettingsPanel();
            if (panel) {
                panel.sendROIStats();
            }
        }
    } catch (e) {
        // Silently fail - stats collection should not interrupt normal operation
    }
}

async function incrementSessionCount(context) {
    const stats = await loadROIStats(context);
    stats.sessionsThisWeek++;
    await context.workspaceState.update(ROI_STATS_KEY, stats);
    log(`ROI Stats: Session count incremented to ${stats.sessionsThisWeek}`);
}

function startStatsCollection(context) {
    if (statsCollectionTimer) clearInterval(statsCollectionTimer);

    // Collect stats every 30 seconds and check for away actions
    statsCollectionTimer = setInterval(() => {
        if (isEnabled) {
            collectAndSaveStats(context);
            checkForAwayActions(context); // Check if user returned from away
        }
    }, 30000);

    log('ROI Stats: Collection started (every 30s)');
}


function updateStatusBar() {
    if (!statusBarItem) return;

    if (isEnabled) {
        let statusText = 'ON';
        let tooltip = `Multi Purpose is running.`;
        let bgColor = undefined;
        let icon = '\u{2705}';

        const cdpConnected = cdpHandler && cdpHandler.getConnectionCount() > 0;

        if (cdpConnected) {
            tooltip += ' (CDP Connected)';
        }

        if (isLockedOut) {
            statusText = 'PAUSED (Multi-window)';
            bgColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            icon = '\u{1F504}';
        }

        statusBarItem.text = `${icon} Multi Purpose: ${statusText}`;
        statusBarItem.tooltip = tooltip;
        statusBarItem.backgroundColor = bgColor;

    } else {
        statusBarItem.text = '\u{2B55} Multi Purpose: OFF';
        statusBarItem.tooltip = 'Click to enable Multi Purpose.';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}


// --- Antigravity Backend Integration ---

/**
 * Initialize the Antigravity client connection (non-blocking)
 */
async function initAntigravityClient() {
    try {
        const ClientClass = getAntigravityClient();
        if (!ClientClass) {
            log('[Antigravity] Failed to load AntigravityClient class');
            return false;
        }

        antigravityClient = new ClientClass(log);
        const connected = await antigravityClient.connect();

        if (connected) {
            log('[Antigravity] Client connected successfully');
            return true;
        } else {
            log('[Antigravity] Client connection failed');
            return false;
        }
    } catch (e) {
        log(`[Antigravity] Init error: ${e.message}`);
        return false;
    }
}

/**
 * Handle the checkAntigravityStatus command
 */
async function handleCheckAntigravityStatus() {
    log('[Antigravity] Checking status...');

    // Try to connect if not already connected
    if (!antigravityClient || !antigravityClient.isConnected()) {
        const connected = await initAntigravityClient();

        if (!connected) {
            vscode.window.showWarningMessage(
                'Antigravity: Could not connect to language server. Is Antigravity running?'
            );
            return { connected: false };
        }
    }

    const status = antigravityClient.getStatus();
    vscode.window.showInformationMessage(`Antigravity: ${status}`);
    return { connected: true, status };
}

/**
 * Handle the getAntigravityQuota command - returns quota data for settings panel
 */
async function handleGetAntigravityQuota() {
    log('[Antigravity] Fetching quota...');

    // Try to connect if not already connected
    if (!antigravityClient || !antigravityClient.isConnected()) {
        const connected = await initAntigravityClient();
        if (!connected) {
            return null;
        }
    }

    try {
        return await antigravityClient.getUserStatus();
    } catch (e) {
        log(`[Antigravity] Quota fetch error: ${e.message}`);
        return null;
    }
}

/**
 * Update the quota status bar item
 */
function updateQuotaStatusBar(text, tooltip) {
    if (statusQuotaItem) {
        statusQuotaItem.text = `\u{1F4CA} ${text}`;
        statusQuotaItem.tooltip = tooltip || 'Antigravity Quota - Click to view details';
    }
}

/**
 * Fetch quota and update status bar
 */
async function refreshQuotaStatus() {
    if (!antigravityClient || !antigravityClient.isConnected()) {
        updateQuotaStatusBar('N/A', 'Not connected to Antigravity');
        return;
    }

    try {
        const snapshot = await antigravityClient.getUserStatus();

        // Determine if any model is exhausted
        let anyExhausted = false;

        if (snapshot.models && snapshot.models.length > 0) {
            // Find the model with lowest quota for the icon
            // Find the model with lowest quota for the icon
            const sortedModels = snapshot.models
                .sort((a, b) => {
                    // Exhausted first
                    if (a.isExhausted && !b.isExhausted) return -1;
                    if (!a.isExhausted && b.isExhausted) return 1;

                    // Then by percentage
                    const pA = a.remainingPercentage !== undefined ? a.remainingPercentage : 0;
                    const pB = b.remainingPercentage !== undefined ? b.remainingPercentage : 0;
                    return pA - pB;
                });

            const lowestModel = sortedModels[0];

            // Check if any model is exhausted
            anyExhausted = snapshot.models.some(m => m.isExhausted === true);

            if (lowestModel) {
                const pct = (lowestModel.remainingPercentage !== undefined ? lowestModel.remainingPercentage : 0).toFixed(0) + '%';
                const icon = lowestModel.isExhausted ? '\u{1F534}' :
                    lowestModel.remainingPercentage < 20 ? '\u{1F7E0}' : '\u{1F7E2}';

                // Build tooltip with ALL model quotas
                const tooltipLines = ['\u{1F4CA} Antigravity Model Quotas:'];
                for (const model of snapshot.models) {
                    const mIcon = model.isExhausted ? '\u{1F534}' :
                        model.remainingPercentage < 20 ? '\u{1F7E0}' : '\u{1F7E2}';
                    const mPct = (model.remainingPercentage !== undefined ? model.remainingPercentage : 0).toFixed(0) + '%';

                    const resetInfo = model.timeUntilResetFormatted ? ` - ${model.timeUntilResetFormatted}` : '';
                    tooltipLines.push(`${mIcon} ${model.label}: ${mPct}${resetInfo}`);
                }
                tooltipLines.push('', 'Click to view details');

                updateQuotaStatusBar(
                    `${icon} ${pct}`,
                    tooltipLines.join('\n')
                );
            } else {
                updateQuotaStatusBar('OK', 'Quota available');
            }
        } else if (snapshot.promptCredits) {
            const pct = snapshot.promptCredits.remainingPercentage.toFixed(0);
            updateQuotaStatusBar(
                `${pct}%`,
                `Prompt Credits: ${snapshot.promptCredits.available}/${snapshot.promptCredits.monthly}`
            );
        } else {
            updateQuotaStatusBar('OK', 'Connected to Antigravity');
        }

        // Notify scheduler of quota status change
        if (scheduler) {
            scheduler.setQuotaExhausted(anyExhausted);
        }
    } catch (e) {
        log(`[Antigravity] Quota refresh error: ${e.message}`);
        updateQuotaStatusBar('ERR', `Error: ${e.message}`);
    }
}

/**
 * Start polling for quota updates
 */
function startQuotaPolling(intervalMs = 120000) {
    stopQuotaPolling();

    // Initial fetch
    refreshQuotaStatus();

    // Start polling
    quotaPollingTimer = setInterval(() => {
        refreshQuotaStatus();
    }, intervalMs);

    log(`[Antigravity] Quota polling started (interval: ${intervalMs}ms)`);
}

/**
 * Stop quota polling
 */
function stopQuotaPolling() {
    if (quotaPollingTimer) {
        clearInterval(quotaPollingTimer);
        quotaPollingTimer = null;
        log('[Antigravity] Quota polling stopped');
    }
}

/**
 * Toggle Antigravity Quota display
 */
function handleToggleAntigravityQuota(enabled) {
    const config = vscode.workspace.getConfiguration('antigravity-mpa.antigravityQuota');
    config.update('enabled', enabled, vscode.ConfigurationTarget.Global);

    if (enabled) {
        if (statusQuotaItem) statusQuotaItem.show();

        if (antigravityClient && antigravityClient.isConnected()) {
            const pollInterval = config.get('pollInterval', 120) * 1000;
            startQuotaPolling(pollInterval);
        } else {
            initAntigravityClient().then(connected => {
                if (connected) {
                    const pollInterval = config.get('pollInterval', 120) * 1000;
                    startQuotaPolling(pollInterval);
                }
            });
        }
    } else {
        stopQuotaPolling();
        if (statusQuotaItem) statusQuotaItem.hide();
    }
}

// --- Debug HTTP Server ---
function startDebugServer() {
    if (debugServer) return;

    // Check if debug mode is enabled
    const debugEnabled = vscode.workspace.getConfiguration('antigravity-mpa.debugMode').get('enabled', false);
    if (!debugEnabled) return;

    try {
        debugServer = http.createServer(async (req, res) => {
            // CORS headers
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }

            if (req.method !== 'POST') {
                res.writeHead(405);
                res.end('Method not allowed');
                return;
            }

            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', async () => {
                try {
                    let data = {};
                    if (body) {
                        data = JSON.parse(body);
                    }
                    const { action, params } = data;
                    log(`[DebugServer] Received action: ${action}`);

                    const result = await vscode.commands.executeCommand('antigravity-mpa.debugCommand', action, params);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: e.message }));
                }
            });
        });

        debugServer.listen(54321, '127.0.0.1', () => {
            log('Debug Server running on http://127.0.0.1:54321');
        });

        debugServer.on('error', (e) => {
            log(`Debug Server Error: ${e.message}`);
            debugServer = null;
        });

    } catch (e) {
        log(`Failed to start Debug Server: ${e.message}`);
    }
}

function stopDebugServer() {
    if (debugServer) {
        debugServer.close();
        debugServer = null;
        log('Debug Server stopped');
    }
}

async function deactivate() {
    stopPolling();
    stopQuotaPolling();
    stopDebugServer();
    if (cdpHandler) {
        cdpHandler.stop();
    }
    if (antigravityClient) {
        antigravityClient.disconnect();
        antigravityClient = null;
    }

    // Cleanup: Clear all extension state (for uninstall)
    if (globalContext) {
        try {
            await globalContext.globalState.update(GLOBAL_STATE_KEY, undefined);
            await globalContext.globalState.update(FREQ_STATE_KEY, undefined);
            await globalContext.globalState.update(BANNED_COMMANDS_KEY, undefined);
            await globalContext.globalState.update(ROI_STATS_KEY, undefined);
            await globalContext.globalState.update(CDP_SETUP_COMPLETED_KEY, undefined);
            await globalContext.globalState.update(EXTENSION_VERSION_KEY, undefined);
        } catch (e) {
            // Ignore cleanup errors
        }
    }

    // Cleanup: Remove log files
    try {
        const fs = require('fs');
        const path = require('path');
        const logPattern = /^multi-purpose-cdp-.*\.log$/;
        const files = fs.readdirSync(extensionRoot);
        for (const file of files) {
            if (logPattern.test(file)) {
                fs.unlinkSync(path.join(extensionRoot, file));
            }
        }
    } catch (e) {
        // Ignore cleanup errors
    }
}

module.exports = { activate, deactivate };
