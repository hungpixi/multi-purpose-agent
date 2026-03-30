const vscode = require('vscode');

class Scheduler {
    constructor(context, cdpHandler, logFn, options = {}) {
        this.context = context;
        this.cdpHandler = cdpHandler;
        this.log = logFn;
        this.timer = null;
        this.silenceTimer = null;
        this.lastRunTime = Date.now();
        this.lastClickTime = 0;
        this.lastClickCount = 0;
        this.lastActivityTime = 0;
        this.enabled = false;
        this.isQuotaExhausted = false;
        this.config = {};
        this.promptQueue = Promise.resolve();

        // Queue mode state
        this.runtimeQueue = [];
        this.queueIndex = 0;
        this.isRunningQueue = false;
        this.isStopped = false; // Flag to cancel pending prompts
        this.queueRunId = 0;
        this.taskStartTime = 0;
        this.hasSentCurrentItem = false;
        this.activationTime = Date.now(); // Track when scheduler was created for activation guard
        this.ensureCdpReady = typeof options.ensureCdpReady === 'function' ? options.ensureCdpReady : null;
        this.lastCdpSyncTime = 0;

        // Multi-queue ready architecture (single conversation for now)
        this.targetConversation = '';  // '' = current active tab
        this.promptHistory = [];       // HistoryEntry[]
        this.conversationStatus = 'idle'; // 'idle'|'running'|'waiting'
        this.isPaused = false;         // User-initiated pause
    }

    async ensureCdpReadyNow(reason, force = false) {
        if (!this.ensureCdpReady) return;
        const now = Date.now();
        if (!force && this.lastCdpSyncTime && (now - this.lastCdpSyncTime) < 2000) return;
        this.lastCdpSyncTime = now;
        try {
            this.log(`Scheduler: Syncing CDP (${reason})...`);
            await this.ensureCdpReady();
        } catch (e) {
            this.log(`Scheduler: CDP sync failed: ${e?.message || String(e)}`);
        }
    }

    start() {
        this.loadConfig();
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => this.check(), 60000);

        // Silence detection timer (runs more frequently)
        if (this.silenceTimer) clearInterval(this.silenceTimer);
        this.silenceTimer = setInterval(() => this.checkSilence(), 5000);

        // Reset activation time when scheduler starts (for accurate grace period)
        this.activationTime = Date.now();
        this.log('Scheduler started.');
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.silenceTimer) {
            clearInterval(this.silenceTimer);
            this.silenceTimer = null;
        }
        this.isRunningQueue = false;
    }

    loadConfig() {
        const cfg = vscode.workspace.getConfiguration('antigravity-mpa.schedule');
        const newEnabled = cfg.get('enabled', false);

        // Reset timer on rising edge (Disabled -> Enabled)
        if (!this.enabled && newEnabled) {
            this.lastRunTime = Date.now();
            this.log('Scheduler: Enabled via config update - Timer reset');
        }
        this.enabled = newEnabled;
        this.config = {
            mode: cfg.get('mode', 'interval'),
            value: cfg.get('value', '30'),
            prompt: cfg.get('prompt', 'Status report please'),
            prompts: cfg.get('prompts', []),
            queueMode: cfg.get('queueMode', 'consume'),
            silenceTimeout: cfg.get('silenceTimeout', 30) * 1000, // Convert to ms
            checkPromptEnabled: cfg.get('checkPrompt.enabled', false),
            checkPromptText: cfg.get('checkPrompt.text', 'Make sure that the previous task was implemented fully as per requirements, implement all gaps, fix all bugs and test everything. Make sure that you reused existing code where possible instead of duplicating code. ultrathink internally avoiding verbosity.')
        };
        this.log(`Scheduler Config: mode=${this.config.mode}, enabled=${this.enabled}, prompts=${this.config.prompts.length}`);
    }

    buildRuntimeQueue() {
        const prompts = [...this.config.prompts];
        if (prompts.length === 0) return [];

        const queue = [];
        for (let i = 0; i < prompts.length; i++) {
            queue.push({ type: 'task', text: prompts[i], index: i });
            if (this.config.checkPromptEnabled) {
                queue.push({ type: 'check', text: this.config.checkPromptText, afterIndex: i });
            }
        }
        return queue;
    }

    async check() {
        this.loadConfig();
        if (!this.enabled || !this.cdpHandler) return;

        const now = new Date();
        const mode = this.config.mode;
        const val = this.config.value;

        if (mode === 'interval') {
            const minutes = parseInt(val) || 30;
            const ms = minutes * 60 * 1000;
            if (Date.now() - this.lastRunTime > ms) {
                this.log(`Scheduler: Interval triggered (${minutes}m)`);
                await this.trigger();
            }
        } else if (mode === 'daily') {
            const [targetH, targetM] = val.split(':').map(Number);
            if (now.getHours() === targetH && now.getMinutes() === targetM) {
                if (Date.now() - this.lastRunTime > 60000) {
                    this.log(`Scheduler: Daily triggered (${val})`);
                    await this.trigger();
                }
            }
        }
        // Queue mode is handled via startQueue() and silence detection
    }

    async checkSilence() {
        // Queue advancement only requires: running queue + CDP connection + queue mode
        // Note: this.enabled is for scheduled runs; manual "Run Queue" doesn't need it
        if (!this.cdpHandler || !this.isRunningQueue) return;
        if (this.config.mode !== 'queue') return;
        if (this.isPaused) return; // User paused - wait for resume
        if (this.isQuotaExhausted) return; // Don't advance if quota exhausted

        // Get current click count from CDP
        try {
            const stats = await this.cdpHandler.getStats();
            const currentClicks = stats?.clicks || 0;

            // If clicks happened, update last click time
            if (currentClicks > this.lastClickCount) {
                this.lastClickTime = Date.now();
                this.lastActivityTime = this.lastClickTime;
                this.lastClickCount = currentClicks;
                this.log(`Scheduler: Activity detected (${currentClicks} clicks)`);
            }

            // Check if silence timeout reached (only after we've successfully sent the current queue item)
            const silenceDuration = Date.now() - (this.lastActivityTime || this.lastClickTime || Date.now());
            const taskDuration = Date.now() - this.taskStartTime;

            // Only advance if:
            // 1. We've been running this task for at least 10 seconds
            // 2. We successfully sent the current queue item
            // 3. Silence duration exceeds timeout
            if (taskDuration > 10000 && this.hasSentCurrentItem && silenceDuration > this.config.silenceTimeout) {
                this.log(`Scheduler: Silence detected (${Math.round(silenceDuration / 1000)}s), advancing queue`);
                await this.advanceQueue();
            }
        } catch (e) {
            this.log(`Scheduler: Error checking silence: ${e.message}`);
        }
    }

    async startQueue(options) {
        // CRITICAL: Require explicit source for all startQueue calls
        const validSources = ['manual', 'debug-server', 'resume', 'test'];
        const source = options?.source;

        // DEBUG: Trace caller if no valid source
        if (!source || !validSources.includes(source)) {
            this.log(`Scheduler: BLOCKED startQueue - invalid source: "${source}". Valid: ${validSources.join(', ')}`);
            this.log('Scheduler: Stack trace: ' + new Error().stack);
            return; // Block phantom callers
        }

        this.log(`Scheduler: startQueue called with source: ${source}`);

        // Dampener: Prevent rapid restarts/loops (2 second cooldown)
        if (this.lastStartQueueTime && Date.now() - this.lastStartQueueTime < 2000) {
            this.log('Scheduler: Ignoring rapid startQueue call (< 2s)');
            return;
        }
        this.lastStartQueueTime = Date.now();

        // ACTIVATION GUARD: Block non-manual starts during activation grace period.
        // Prevents config/debug automation from triggering queue start on reload, while still allowing user clicks.
        if (this.activationTime && Date.now() - this.activationTime < 5000 && source !== 'manual' && source !== 'test') {
            this.log(`Scheduler: BLOCKED startQueue during activation grace period (${Math.round((Date.now() - this.activationTime) / 1000)}s < 5s)`);
            return;
        }

        // Load config first to get current state
        this.loadConfig();

        // Prevent auto-starting queue when scheduler is enabled but user hasn't explicitly started it
        if (this.config.mode === 'queue' && this.isRunningQueue) {
            this.log('Scheduler: Queue is already running, ignoring duplicate startQueue call');
            return;
        }

        this.log(`Scheduler: Queue start proceeding (source: ${source})`);

        if (this.config.mode !== 'queue') {
            this.log('Scheduler: Not in queue mode, ignoring startQueue');
            vscode.window.showWarningMessage('Antigravity Multi Purpose: Set mode to "Queue" first.');
            return;
        }

        // Ensure we have fresh CDP connections and injected helpers (chat webviews may not exist at activation time).
        await this.ensureCdpReadyNow('startQueue', true);

        this.runtimeQueue = this.buildRuntimeQueue();
        this.queueIndex = 0;
        this.isRunningQueue = true;
        this.isStopped = false; // Clear stopped flag when starting
        this.lastClickCount = 0;
        this.lastClickTime = Date.now();
        this.lastActivityTime = Date.now();
        this.taskStartTime = Date.now();
        this.hasSentCurrentItem = false;

        this.log(`Scheduler: Starting queue with ${this.runtimeQueue.length} items`);

        if (this.runtimeQueue.length === 0) {
            this.log('Scheduler: Queue is empty, nothing to run');
            if (options && options.source === 'manual') {
                // Warning Dampener: Prevent spamming warnings loop
                const now = Date.now();
                if (this.queueWarningDampener && (now - this.queueWarningDampener < 5000)) {
                    this.log('Scheduler: Suppressed empty queue warning (dampener active)');
                } else {
                    vscode.window.showWarningMessage('Antigravity Multi Purpose: Prompt queue is empty. Add prompts first.');
                    this.queueWarningDampener = now;
                }
            } else {
                this.log('Scheduler: Suppressing empty queue warning (auto-start or no source)');
            }
            this.isRunningQueue = false;
            this.hasSentCurrentItem = false;
            return;
        }

        await this.executeCurrentQueueItem();
    }

    async advanceQueue() {
        if (!this.isRunningQueue) return;

        // In consume mode, remove the completed prompt from config immediately
        if (this.config.queueMode === 'consume') {
            await this.consumeCurrentPrompt();
        }

        this.queueIndex++;
        this.lastClickCount = 0;
        this.lastClickTime = Date.now();
        this.lastActivityTime = Date.now();
        this.taskStartTime = Date.now();
        this.hasSentCurrentItem = false;

        if (this.queueIndex >= this.runtimeQueue.length) {
            if (this.config.queueMode === 'loop' && this.runtimeQueue.length > 0) {
                this.log('Scheduler: Queue completed, looping...');
                this.queueIndex = 0;
                // Rebuild queue to respect any config changes
                this.loadConfig();
                this.runtimeQueue = this.buildRuntimeQueue();
            } else {
                this.log('Scheduler: Queue completed, stopping');
                this.isRunningQueue = false;
                vscode.window.showInformationMessage('Antigravity Multi Purpose: Prompt queue completed!');
                return;
            }
        }

        await this.executeCurrentQueueItem();
    }

    async executeCurrentQueueItem() {
        const runId = this.queueRunId;
        if (!this.isRunningQueue || this.isStopped) return;
        if (this.queueIndex >= this.runtimeQueue.length) return;

        const item = this.runtimeQueue[this.queueIndex];
        const itemType = item.type === 'check' ? 'Check Prompt' : `Task ${item.index + 1}`;

        this.log(`Scheduler: Executing ${itemType}: "${item.text.substring(0, 50)}..."`);
        this.conversationStatus = 'running';
        vscode.window.showInformationMessage(`Multi Purpose: Sending ${itemType}`);

        if (this.isStopped || runId !== this.queueRunId) return;
        await this.sendPrompt(item.text);
        // Note: addToHistory is called inside queuePrompt after successful send
    }

    async resume() {
        this.isQuotaExhausted = false;

        const resumeConfig = vscode.workspace.getConfiguration('antigravity-mpa.antigravityQuota.resume');
        const queueResumeEnabled = resumeConfig.get('enabled', true);

        const autoContinueConfig = vscode.workspace.getConfiguration('antigravity-mpa.autoContinue');
        const autoContinueEnabled = autoContinueConfig.get('enabled', false);

        // 1. Handle Queue Resume (Prioritized)
        if (this.isRunningQueue && this.config.mode === 'queue') {
            if (queueResumeEnabled) {
                this.log('Scheduler: Quota reset, resuming queue task');
                vscode.window.showInformationMessage('Antigravity Multi Purpose: Quota reset! Resuming queue...');
                this.lastClickTime = Date.now();
                this.lastActivityTime = this.lastClickTime;
                this.taskStartTime = Date.now();
                this.lastClickCount = 0;
                this.hasSentCurrentItem = false;
                // Re-send current item to continue
                await this.executeCurrentQueueItem();
                return;
            } else {
                this.log('Scheduler: Quota reset, but queue resume disabled.');
            }
        }

        // 2. Handle Generic Auto-Continue (if not in queue or queue resume disabled)
        if (autoContinueEnabled) {
            this.log('Scheduler: Quota reset, sending "Continue" prompt');
            vscode.window.showInformationMessage('Antigravity Multi Purpose: Quota reset! Sending "Continue"...');
            await this.sendPrompt('Continue');
        } else {
            this.log('Scheduler: Quota reset, but auto-continue disabled.');
        }

        // NOTE: Do NOT auto-start queue if not running - user must explicitly click Start Queue.
    }

    async consumeCurrentPrompt() {
        try {
            const config = vscode.workspace.getConfiguration('antigravity-mpa.schedule');
            const prompts = config.get('prompts', []);
            if (prompts.length > 0) {
                // Remove the first prompt (the one that was just completed)
                const remaining = prompts.slice(1);
                await config.update('prompts', remaining, vscode.ConfigurationTarget.Global);
                this.log(`Scheduler: Consumed prompt, ${remaining.length} remaining`);
            }
        } catch (e) {
            this.log(`Scheduler: Error consuming prompt: ${e.message}`);
        }
    }

    async consumeCompletedPrompts() {
        try {
            const config = vscode.workspace.getConfiguration('antigravity-mpa.schedule');
            // Clear the prompts array after successful completion
            await config.update('prompts', [], vscode.ConfigurationTarget.Global);
            this.log('Scheduler: Consumed prompts cleared from config');
        } catch (e) {
            this.log(`Scheduler: Error clearing consumed prompts: ${e.message}`);
        }
    }

    setQuotaExhausted(exhausted) {
        const wasExhausted = this.isQuotaExhausted;
        this.isQuotaExhausted = exhausted;

        if (wasExhausted && !exhausted) {
            this.log('Scheduler: Quota transitioned from exhausted to available');
            this.resume();
        } else if (exhausted && !wasExhausted) {
            this.log('Scheduler: Quota became exhausted, pausing queue');
        }
    }

    async queuePrompt(text) {
        const runId = this.queueRunId;
        this.promptQueue = this.promptQueue.then(async () => {
            // Check if queue was stopped before we could send
            if (this.isStopped || runId !== this.queueRunId) {
                this.log('Scheduler: Prompt cancelled (queue stopped)');
                return;
            }

            this.lastRunTime = Date.now();
            if (!text) return;

            this.log(`Scheduler: Sending prompt "${text.substring(0, 50)}..."`);

            // Use CDP only - the verified working method
            if (this.cdpHandler) {
                try {
                    // Ensure CDP has scanned/injected latest chat surfaces before attempting to send.
                    await this.ensureCdpReadyNow('queuePrompt');
                    if (this.isStopped || runId !== this.queueRunId) return;

                    const rawSentCount = await this.cdpHandler.sendPrompt(text, this.targetConversation);
                    let sentCount = typeof rawSentCount === 'number' ? rawSentCount : (rawSentCount ? 1 : 0);
                    if (this.isStopped || runId !== this.queueRunId) return;

                    // One retry after a forced resync (chat webview can spawn after we started the queue)
                    if (sentCount === 0 && this.ensureCdpReady) {
                        this.log('Scheduler: Prompt not delivered, forcing CDP resync and retrying once...');
                        await this.ensureCdpReadyNow('queuePrompt-retry', true);
                        if (this.isStopped || runId !== this.queueRunId) return;
                        const rawRetry = await this.cdpHandler.sendPrompt(text, this.targetConversation);
                        sentCount = typeof rawRetry === 'number' ? rawRetry : (rawRetry ? 1 : 0);
                        if (this.isStopped || runId !== this.queueRunId) return;
                    }

                    // CRITICAL FIX: If 0 prompts sent, we must abort, otherwise we wait for silence forever
                    if (sentCount === 0) {
                        throw new Error('Prompt not delivered (no active chat input / send function found).');
                    }

                    this.addToHistory(text, this.targetConversation);
                    if (this.isRunningQueue && this.config.mode === 'queue') {
                        this.hasSentCurrentItem = true;
                        this.lastActivityTime = Date.now();
                    }
                    this.log(`Scheduler: Prompt sent via CDP (${sentCount} tabs)`);
                } catch (err) {
                    this.log(`Scheduler: CDP failed: ${err.message}`);
                    vscode.window.showErrorMessage(`Queue Error: ${err.message}`);
                    // Force stop queue on critical error to prevent "Running" ghost state
                    this.stopQueue();
                    return;
                }
            } else {
                this.log('Scheduler: CDP handler not available');
                if (this.isRunningQueue && this.config.mode === 'queue') {
                    vscode.window.showErrorMessage('Queue Error: CDP handler not available.');
                    this.stopQueue();
                }
            }
        }).catch(err => {
            this.log(`Scheduler Error: ${err.message}`);
        });
        return this.promptQueue;
    }

    async sendPrompt(text) {
        return this.queuePrompt(text);
    }

    async trigger() {
        const text = this.config.prompt;
        return this.queuePrompt(text);
    }

    getStatus() {
        return {
            enabled: this.enabled,
            mode: this.config.mode,
            isRunningQueue: this.isRunningQueue,
            queueLength: this.runtimeQueue.length,
            queueIndex: this.queueIndex,
            isQuotaExhausted: this.isQuotaExhausted,
            targetConversation: this.targetConversation,
            conversationStatus: this.conversationStatus,
            isPaused: this.isPaused,
            currentPrompt: this.getCurrentPrompt()
        };
    }

    async getConversations() {
        if (!this.cdpHandler) return [];
        try {
            return await this.cdpHandler.getConversations();
        } catch (e) {
            this.log(`Scheduler: Error getting conversations: ${e.message}`);
            return [];
        }
    }

    addToHistory(text, conversationId) {
        const entry = {
            text: text.substring(0, 100),
            fullText: text,
            timestamp: Date.now(),
            status: 'sent',
            conversationId: conversationId || this.targetConversation || 'current'
        };
        this.promptHistory.push(entry);
        // Keep last 50 entries
        if (this.promptHistory.length > 50) {
            this.promptHistory.shift();
        }
        this.log(`Scheduler: Added to history: "${entry.text.substring(0, 50)}..."`);
    }

    getHistory() {
        return this.promptHistory.map(h => ({
            text: h.text,
            timestamp: h.timestamp,
            timeAgo: this.formatTimeAgo(h.timestamp),
            status: h.status,
            conversation: h.conversationId
        }));
    }

    formatTimeAgo(ts) {
        const diff = Date.now() - ts;
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
        if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
        return Math.floor(diff / 86400000) + 'd ago';
    }

    setTargetConversation(conversationId) {
        this.targetConversation = conversationId || '';
        this.log(`Scheduler: Target conversation set to: "${this.targetConversation || 'current'}"`);
    }

    // Queue control methods
    pauseQueue() {
        if (!this.isRunningQueue || this.isPaused) return false;
        this.isPaused = true;
        this.log('Scheduler: Queue paused by user');
        vscode.window.showInformationMessage('Queue paused.');
        return true;
    }

    resumeQueue() {
        if (!this.isRunningQueue || !this.isPaused) return false;
        this.isPaused = false;
        this.log('Scheduler: Queue resumed by user');
        vscode.window.showInformationMessage('Queue resumed.');
        // Trigger next check immediately
        this.checkSilence();
        return true;
    }

    async skipPrompt() {
        if (!this.isRunningQueue) return false;
        this.log('Scheduler: Skipping current prompt');
        vscode.window.showInformationMessage('Skipping to next prompt...');

        // Advance without sending current
        this.queueIndex++;
        this.isPaused = false; // Clear pause if set
        this.lastClickCount = 0;
        this.lastClickTime = Date.now();
        this.lastActivityTime = Date.now();
        this.taskStartTime = Date.now();
        this.hasSentCurrentItem = false;

        if (this.queueIndex >= this.runtimeQueue.length) {
            this.log('Scheduler: No more prompts to skip to, queue complete');
            this.isRunningQueue = false;
            this.conversationStatus = 'idle';
            return true;
        }

        // Execute next item
        await this.executeCurrentQueueItem();
        return true;
    }

    stopQueue() {
        if (!this.isRunningQueue && this.runtimeQueue.length === 0) return false;
        this.isRunningQueue = false;
        this.isStopped = true; // Signal pending prompts to cancel
        this.queueRunId++;
        this.runtimeQueue = [];
        this.queueIndex = 0;
        this.conversationStatus = 'idle';
        this.isPaused = false;
        this.lastClickCount = 0;
        this.lastClickTime = 0;
        this.lastActivityTime = 0;
        this.taskStartTime = 0;
        this.hasSentCurrentItem = false;
        // Reset the prompt queue to cancel pending operations
        this.promptQueue = Promise.resolve();
        this.log('Scheduler: Queue stopped by user');
        vscode.window.showInformationMessage('Queue stopped.');
        return true;
    }

    async resetQueue() {
        // Stop the queue if running
        this.isRunningQueue = false;
        this.isStopped = false; // Reset the stopped flag
        this.queueRunId++;
        this.runtimeQueue = [];
        this.queueIndex = 0;
        this.conversationStatus = 'idle';
        this.isPaused = false;
        this.lastClickCount = 0;
        this.lastClickTime = 0;
        this.lastActivityTime = 0;
        this.taskStartTime = 0;
        this.hasSentCurrentItem = false;
        this.promptQueue = Promise.resolve(); // Clear pending prompts

        // Clear prompts from config
        try {
            const config = vscode.workspace.getConfiguration('antigravity-mpa.schedule');
            await config.update('prompts', [], vscode.ConfigurationTarget.Global);
            this.log('Scheduler: Queue reset - all prompts cleared');
        } catch (e) {
            this.log(`Scheduler: Error resetting queue: ${e.message}`);
        }

        vscode.window.showInformationMessage('Queue reset.');
        return true;
    }

    getCurrentPrompt() {
        if (!this.isRunningQueue || this.queueIndex >= this.runtimeQueue.length) return null;
        return this.runtimeQueue[this.queueIndex];
    }
}

module.exports = { Scheduler };
