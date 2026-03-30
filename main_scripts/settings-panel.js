/**
 * MPA v3.0 PROMAX — Settings Panel Controller
 * Refactored: CSS/HTML/JS extracted to webview/ folder
 * This file is now a thin WebView controller only (~300 lines vs old 1985 lines)
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
let globalWarningDampener = 0;

class SettingsPanel {
    static currentPanel = undefined;
    static viewType = 'autoAcceptSettings';

    static createOrShow(extensionUri, context, mode = 'settings') {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SettingsPanel.currentPanel) {
            SettingsPanel.currentPanel.panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            SettingsPanel.viewType,
            'Antigravity Multi Purpose Agent Settings',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'webview')
                ],
                retainContextWhenHidden: true
            }
        );

        SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, context);
    }

    constructor(panel, extensionUri, context) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.context = context;
        this.disposables = [];

        this.update();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'setFrequency':
                        await this.context.globalState.update('antigravity-mpa-frequency', message.value);
                        vscode.commands.executeCommand('antigravity-mpa.updateFrequency', message.value);
                        break;
                    case 'getStats':
                        this.sendStats();
                        break;
                    case 'getROIStats':
                        this.sendROIStats();
                        break;
                    case 'updateBannedCommands':
                        await this.context.globalState.update('antigravity-mpa-banned-commands', message.commands);
                        vscode.commands.executeCommand('antigravity-mpa.updateBannedCommands', message.commands);
                        break;
                    case 'getBannedCommands':
                        this.sendBannedCommands();
                        break;
                    case 'updateSchedule':
                        await this._updateScheduleConfig(message);
                        break;
                    case 'saveAndStartQueue':
                        await this._saveAndStartQueue(message);
                        break;
                    case 'getSchedule':
                        this.sendSchedule();
                        break;
                    case 'startQueue':
                        this._startQueue();
                        break;
                    case 'setResumeEnabled': {
                        const resumeConfig = vscode.workspace.getConfiguration('antigravity-mpa.antigravityQuota.resume');
                        await resumeConfig.update('enabled', message.value, vscode.ConfigurationTarget.Global);
                        break;
                    }
                    case 'setAutoContinue': {
                        const autoContinueConfig = vscode.workspace.getConfiguration('antigravity-mpa.autoContinue');
                        await autoContinueConfig.update('enabled', message.value, vscode.ConfigurationTarget.Global);
                        break;
                    }
                    case 'getLogs':
                        this.sendLogs(message.tailLines);
                        break;
                    case 'openLogFile':
                        this.openLogFile();
                        break;
                    case 'clearLogs':
                        this.clearLogs();
                        break;
                    case 'resetAllSettings':
                        vscode.commands.executeCommand('antigravity-mpa.resetSettings');
                        break;
                    case 'setAntigravityQuota':
                        vscode.commands.executeCommand('antigravity-mpa.toggleAntigravityQuota', message.value);
                        break;
                    case 'getAntigravityQuota':
                        this.sendAntigravityQuotaEnabled();
                        break;
                    case 'refreshAntigravityQuota':
                        this.sendAntigravityQuotaStatus();
                        break;
                    case 'getQueueStatus':
                        this.sendQueueStatus();
                        break;
                    case 'getConversations':
                        this.sendConversations();
                        break;
                    case 'getPromptHistory':
                        this.sendPromptHistory();
                        break;
                    case 'pauseQueue':
                        vscode.commands.executeCommand('antigravity-mpa.pauseQueue');
                        break;
                    case 'resumeQueue':
                        vscode.commands.executeCommand('antigravity-mpa.resumeQueue');
                        break;
                    case 'skipPrompt':
                        vscode.commands.executeCommand('antigravity-mpa.skipPrompt');
                        break;
                    case 'stopQueue':
                        vscode.commands.executeCommand('antigravity-mpa.stopQueue');
                        break;
                    case 'setTargetConversation':
                        vscode.commands.executeCommand('antigravity-mpa.setTargetConversation', message.value);
                        break;
                    case 'setDebugMode': {
                        const debugConfig = vscode.workspace.getConfiguration('antigravity-mpa.debugMode');
                        await debugConfig.update('enabled', message.value, vscode.ConfigurationTarget.Global);
                        break;
                    }
                    case 'getDebugMode':
                        this.sendDebugMode();
                        break;
                    case 'setCdpPort': {
                        const cdpConfig = vscode.workspace.getConfiguration('antigravity-mpa');
                        await cdpConfig.update('cdpPort', message.value, vscode.ConfigurationTarget.Global);
                        break;
                    }
                    case 'getCdpPort':
                        this.sendCdpPort();
                        break;
                    case 'debugUIAction':
                        this.handleDebugUIAction(message.action);
                        break;
                    case 'debugUIResult':
                        this.handleDebugUIResult(message.result);
                        break;
                }
            },
            null,
            this.disposables
        );
    }

    // ========================================================
    // PRIVATE HELPERS — Schedule
    // ========================================================
    async _updateScheduleConfig(message) {
        const config = vscode.workspace.getConfiguration('antigravity-mpa.schedule');
        await config.update('enabled', message.enabled, vscode.ConfigurationTarget.Global);
        await config.update('mode', message.mode, vscode.ConfigurationTarget.Global);
        await config.update('value', message.value, vscode.ConfigurationTarget.Global);
        await config.update('prompt', message.prompt, vscode.ConfigurationTarget.Global);
        if (message.prompts !== undefined) await config.update('prompts', message.prompts, vscode.ConfigurationTarget.Global);
        if (message.queueMode !== undefined) await config.update('queueMode', message.queueMode, vscode.ConfigurationTarget.Global);
        if (message.silenceTimeout !== undefined) await config.update('silenceTimeout', message.silenceTimeout, vscode.ConfigurationTarget.Global);
        if (message.checkPromptEnabled !== undefined) await config.update('checkPrompt.enabled', message.checkPromptEnabled, vscode.ConfigurationTarget.Global);
        if (message.checkPromptText !== undefined) await config.update('checkPrompt.text', message.checkPromptText, vscode.ConfigurationTarget.Global);
        if (message.resumeEnabled !== undefined) await vscode.workspace.getConfiguration('antigravity-mpa.antigravityQuota.resume').update('enabled', message.resumeEnabled, vscode.ConfigurationTarget.Global);
        if (message.autoContinueEnabled !== undefined) await vscode.workspace.getConfiguration('antigravity-mpa.autoContinue').update('enabled', message.autoContinueEnabled, vscode.ConfigurationTarget.Global);
    }

    async _saveAndStartQueue(message) {
        const scheduleData = message.schedule || {};
        if (!scheduleData.prompts || scheduleData.prompts.length === 0) {
            const now = Date.now();
            if (now - globalWarningDampener < 2000) return;
            globalWarningDampener = now;
            vscode.window.showWarningMessage('Antigravity Multi Purpose: Cannot start queue without prompts.');
            return;
        }
        const config = vscode.workspace.getConfiguration('antigravity-mpa.schedule');
        await config.update('enabled', true, vscode.ConfigurationTarget.Global);
        if (scheduleData.mode) await config.update('mode', scheduleData.mode, vscode.ConfigurationTarget.Global);
        if (scheduleData.value) await config.update('value', scheduleData.value, vscode.ConfigurationTarget.Global);
        if (scheduleData.prompts) await config.update('prompts', scheduleData.prompts, vscode.ConfigurationTarget.Global);
        if (scheduleData.queueMode) await config.update('queueMode', scheduleData.queueMode, vscode.ConfigurationTarget.Global);
        if (scheduleData.silenceTimeout) await config.update('silenceTimeout', scheduleData.silenceTimeout, vscode.ConfigurationTarget.Global);
        if (scheduleData.checkPromptEnabled !== undefined) await config.update('checkPrompt.enabled', scheduleData.checkPromptEnabled, vscode.ConfigurationTarget.Global);
        if (scheduleData.checkPromptText !== undefined) await config.update('checkPrompt.text', scheduleData.checkPromptText, vscode.ConfigurationTarget.Global);
        if (scheduleData.resumeEnabled !== undefined) await vscode.workspace.getConfiguration('antigravity-mpa.antigravityQuota.resume').update('enabled', scheduleData.resumeEnabled, vscode.ConfigurationTarget.Global);
        if (scheduleData.autoContinueEnabled !== undefined) await vscode.workspace.getConfiguration('antigravity-mpa.autoContinue').update('enabled', scheduleData.autoContinueEnabled, vscode.ConfigurationTarget.Global);
        vscode.commands.executeCommand('antigravity-mpa.startQueue', { source: 'manual' });
    }

    _startQueue() {
        const currentPrompts = vscode.workspace.getConfiguration('antigravity-mpa.schedule').get('prompts', []);
        if (!currentPrompts || currentPrompts.length === 0) {
            const now = Date.now();
            if (now - globalWarningDampener < 2000) return;
            globalWarningDampener = now;
            vscode.window.showWarningMessage('Antigravity Multi Purpose: Prompt queue is empty. Add prompts first.');
            return;
        }
        vscode.commands.executeCommand('antigravity-mpa.startQueue', { source: 'manual' });
    }

    // ========================================================
    // DATA SENDERS — Push data to WebView
    // ========================================================
    sendStats() {
        const stats = this.context.globalState.get('antigravity-mpa-stats', { clicks: 0, sessions: 0, lastSession: null });
        const frequency = this.context.globalState.get('antigravity-mpa-frequency', 1000);
        this.panel.webview.postMessage({ command: 'updateStats', stats, frequency });
    }

    async sendROIStats() {
        try {
            const roiStats = await vscode.commands.executeCommand('antigravity-mpa.getROIStats');
            this.panel.webview.postMessage({ command: 'updateROIStats', roiStats });
        } catch (e) { /* ROI stats not available */ }
    }

    sendDebugMode() {
        const config = vscode.workspace.getConfiguration('antigravity-mpa.debugMode');
        this.panel.webview.postMessage({ command: 'updateDebugMode', enabled: config.get('enabled', true) });
    }

    sendCdpPort() {
        const config = vscode.workspace.getConfiguration('antigravity-mpa');
        this.panel.webview.postMessage({ command: 'updateCdpPort', port: config.get('cdpPort', 9004) });
    }

    sendBannedCommands() {
        const defaultBannedCommands = ['rm -rf /', 'rm -rf ~', 'rm -rf *', 'format c:', 'del /f /s /q', 'rmdir /s /q', ':(){:|:&};:', 'dd if=', 'mkfs.', '> /dev/sda', 'chmod -R 777 /'];
        const bannedCommands = this.context.globalState.get('antigravity-mpa-banned-commands', defaultBannedCommands);
        this.panel.webview.postMessage({ command: 'updateBannedCommands', bannedCommands });
    }

    sendSchedule() {
        const config = vscode.workspace.getConfiguration('antigravity-mpa.schedule');
        const resumeConfig = vscode.workspace.getConfiguration('antigravity-mpa.antigravityQuota.resume');
        this.panel.webview.postMessage({
            command: 'updateSchedule',
            schedule: {
                enabled: config.get('enabled'), mode: config.get('mode'), value: config.get('value'),
                prompt: config.get('prompt'), prompts: config.get('prompts', []),
                queueMode: config.get('queueMode', 'consume'), silenceTimeout: config.get('silenceTimeout', 30),
                checkPromptEnabled: config.get('checkPrompt.enabled', false), checkPromptText: config.get('checkPrompt.text', ''),
                resumeEnabled: resumeConfig.get('enabled', true),
                autoContinueEnabled: vscode.workspace.getConfiguration('antigravity-mpa.autoContinue').get('enabled', false)
            }
        });
    }

    async sendAntigravityQuotaEnabled() {
        try {
            const enabled = await vscode.commands.executeCommand('antigravity-mpa.getAntigravityQuotaEnabled');
            this.panel.webview.postMessage({ command: 'updateAntigravityQuotaEnabled', enabled: enabled !== false });
        } catch (e) {
            this.panel.webview.postMessage({ command: 'updateAntigravityQuotaEnabled', enabled: true });
        }
    }

    async sendAntigravityQuotaStatus() {
        try {
            const snapshot = await vscode.commands.executeCommand('antigravity-mpa.getAntigravityQuota');
            this.panel.webview.postMessage({ command: 'updateAntigravityQuotaStatus', snapshot });
        } catch (e) {
            this.panel.webview.postMessage({ command: 'updateAntigravityQuotaStatus', snapshot: null, error: e.message });
        }
    }

    async sendQueueStatus() {
        try {
            const status = await vscode.commands.executeCommand('antigravity-mpa.getQueueStatus');
            this.panel.webview.postMessage({ command: 'updateQueueStatus', status: status || { enabled: false, isRunningQueue: false, queueLength: 0, queueIndex: 0, isQuotaExhausted: false } });
        } catch (e) {
            this.panel.webview.postMessage({ command: 'updateQueueStatus', status: { enabled: false, isRunningQueue: false, queueLength: 0, queueIndex: 0, isQuotaExhausted: false } });
        }
    }

    async sendConversations() {
        try {
            const conversations = await vscode.commands.executeCommand('antigravity-mpa.getConversations');
            this.panel.webview.postMessage({ command: 'updateConversations', conversations: conversations || [] });
        } catch (e) { this.panel.webview.postMessage({ command: 'updateConversations', conversations: [] }); }
    }

    async sendPromptHistory() {
        try {
            const history = await vscode.commands.executeCommand('antigravity-mpa.getPromptHistory');
            this.panel.webview.postMessage({ command: 'updatePromptHistory', history: history || [] });
        } catch (e) { this.panel.webview.postMessage({ command: 'updatePromptHistory', history: [] }); }
    }

    // ========================================================
    // LOG MANAGEMENT
    // ========================================================
    getLogFilePath() {
        try {
            const dir = this.context.extensionPath;
            const entries = fs.readdirSync(dir);
            const candidates = entries
                .filter(name => name.startsWith('multi-purpose-cdp-') && name.endsWith('.log'))
                .map(name => path.join(dir, name))
                .filter(p => fs.existsSync(p));

            if (candidates.length === 0) {
                const d = new Date();
                const pad2 = (n) => String(n).padStart(2, '0');
                const suffix = `${pad2(d.getMinutes())}${pad2(d.getHours())}-${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${pad2(d.getFullYear() % 100)}`;
                return path.join(dir, `multi-purpose-cdp-${suffix}.log`);
            }

            let best = candidates[0], bestMtime = 0;
            for (const p of candidates) {
                try { const mtime = fs.statSync(p).mtimeMs || 0; if (mtime >= bestMtime) { bestMtime = mtime; best = p; } } catch (e) { }
            }
            return best;
        } catch (e) {
            const d = new Date(), pad2 = (n) => String(n).padStart(2, '0');
            const suffix = `${pad2(d.getMinutes())}${pad2(d.getHours())}-${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${pad2(d.getFullYear() % 100)}`;
            return path.join(this.context.extensionPath, `multi-purpose-cdp-${suffix}.log`);
        }
    }

    sendLogs(tailLines) {
        const filePath = this.getLogFilePath();
        try {
            if (!fs.existsSync(filePath)) {
                this.panel.webview.postMessage({ command: 'updateLogs', logs: '', meta: { filePath, exists: false } });
                return;
            }
            const stat = fs.statSync(filePath);
            const maxBytes = 250000;
            const lines = parseInt(tailLines) || 300;
            const start = Math.max(0, stat.size - maxBytes);
            const fd = fs.openSync(filePath, 'r');
            const buf = Buffer.alloc(stat.size - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            fs.closeSync(fd);
            const allLines = buf.toString('utf8').split(/\r?\n/).filter(l => l.length > 0);
            const tail = allLines.slice(-lines).join('\n');
            this.panel.webview.postMessage({ command: 'updateLogs', logs: tail, meta: { filePath, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, linesShown: Math.min(lines, allLines.length) } });
        } catch (e) {
            this.panel.webview.postMessage({ command: 'updateLogs', logs: `Failed to read logs: ${e.message}`, meta: { filePath, exists: null } });
        }
    }

    async openLogFile() {
        const filePath = this.getLogFilePath();
        try {
            if (!fs.existsSync(filePath)) { vscode.window.showInformationMessage('Log file not found yet.'); return; }
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (e) { vscode.window.showErrorMessage(`Failed to open log file: ${e.message}`); }
    }

    clearLogs() {
        const filePath = this.getLogFilePath();
        try { fs.writeFileSync(filePath, '', 'utf8'); } catch (e) { }
        this.sendLogs(300);
    }

    // ========================================================
    // DEBUG UI BRIDGE
    // ========================================================
    handleDebugUIAction(action) {
        const debugEnabled = vscode.workspace.getConfiguration('antigravity-mpa.debugMode').get('enabled', false);
        if (!debugEnabled) return;
        this.panel.webview.postMessage({ command: 'executeDebugUIAction', action });
    }

    handleDebugUIResult(result) { this._lastUIResult = result; }
    getLastUIResult() { const r = this._lastUIResult; this._lastUIResult = null; return r; }

    // ========================================================
    // HTML GENERATION — Uses external CSS + JS
    // ========================================================
    update() {
        this.panel.webview.html = this.getHtmlContent();
        setTimeout(() => {
            this.sendStats();
            this.sendROIStats();
            this.sendSchedule();
            this.sendLogs(300);
        }, 100);
    }

    getHtmlContent() {
        const webview = this.panel.webview;
        const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', 'styles.css'));
        const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'webview', 'app.js'));

        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <link rel="stylesheet" href="${cssUri}">
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Multi Purpose <span class="badge">Agent</span></h1>
            <div class="subtitle">AI Workflow Orchestrator — Hungpixi Edition v3.0</div>
        </div>

        <div class="section">
            <div class="section-label">
                <span>📊 IMPACT DASHBOARD</span>
                <span style="opacity: 0.4;">Resets Sunday</span>
            </div>
            <div class="impact-grid">
                <div class="impact-card" style="border-bottom: 2px solid var(--green);">
                    <div class="stat-val" id="roiClickCount" style="color: var(--green);">0</div>
                    <div class="stat-label">Clicks Saved</div>
                </div>
                <div class="impact-card">
                    <div class="stat-val" id="roiTimeSaved">0m</div>
                    <div class="stat-label">Time Saved</div>
                </div>
                <div class="impact-card">
                    <div class="stat-val" id="roiSessionCount">0</div>
                    <div class="stat-label">Sessions</div>
                </div>
                <div class="impact-card">
                    <div class="stat-val" id="roiBlockedCount" style="opacity: 0.4;">0</div>
                    <div class="stat-label">Blocked</div>
                </div>
            </div>
        </div>

        <div class="section" id="performanceSection">
            <div class="section-label">
                <span>⚡ Performance Mode</span>
                <span class="val-display" id="freqVal" style="color: var(--accent);">...</span>
            </div>
            <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 8px;">
                <span style="font-size: 12px; opacity: 0.5;">Instant</span>
                <div style="flex: 1;"><input type="range" id="freqSlider" min="200" max="3000" step="100" value="1000"></div>
                <span style="font-size: 12px; opacity: 0.5;">Battery Saving</span>
            </div>
        </div>

        <div class="section">
            <div class="section-label">📋 Prompt Queue</div>
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                <span style="font-size: 13px;">Enable Scheduler</span>
                <label class="switch"><input type="checkbox" id="scheduleEnabled"><span class="slider round"></span></label>
            </div>
            <div id="scheduleControls" style="opacity: 0.5; pointer-events: none; transition: opacity 0.3s;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
                    <div>
                        <label style="font-size: 11px; color: var(--fg-dim); display: block; margin-bottom: 4px;">Mode</label>
                        <select id="scheduleMode" style="width: 100%; background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: var(--fg); padding: 10px 12px; border-radius: 10px;">
                            <option value="interval">Interval (Every X min)</option>
                            <option value="daily">Daily (At HH:MM)</option>
                            <option value="queue" selected>Queue (Sequential)</option>
                        </select>
                    </div>
                    <div>
                        <label style="font-size: 11px; color: var(--fg-dim); display: block; margin-bottom: 4px;">Value / Timeout</label>
                        <input type="text" id="scheduleValue" placeholder="30" style="width: 100%; background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: var(--fg); padding: 10px 12px; border-radius: 10px;">
                    </div>
                </div>
                <div id="singlePromptSection" style="margin-bottom: 12px;">
                    <label style="font-size: 11px; color: var(--fg-dim); display: block; margin-bottom: 4px;">Prompt Message</label>
                    <textarea id="schedulePrompt" style="min-height: 60px;" placeholder="Status report please"></textarea>
                </div>
                <div id="queueModeSection" style="display: none;">
                    <div style="margin-bottom: 12px;">
                        <label style="font-size: 11px; color: var(--fg-dim); display: block; margin-bottom: 4px;">Prompt Queue</label>
                        <div class="prompt-list-container">
                            <div id="promptList" class="prompt-list"><div class="prompt-empty">Queue is empty</div></div>
                            <div class="prompt-add-row">
                                <input type="text" id="newPromptInput" class="prompt-input" placeholder="Enter a new task..." />
                                <button id="addPromptBtn" class="btn-primary" style="padding: 0 16px;">Add</button>
                            </div>
                        </div>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
                        <div>
                            <label style="font-size: 11px; color: var(--fg-dim); display: block; margin-bottom: 4px;">Queue Behavior</label>
                            <select id="queueMode" style="width: 100%; background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: var(--fg); padding: 10px 12px; border-radius: 10px;">
                                <option value="consume">Consume (Remove after use)</option>
                                <option value="loop">Loop (Cycle forever)</option>
                            </select>
                        </div>
                        <div>
                            <label style="font-size: 11px; color: var(--fg-dim); display: block; margin-bottom: 4px;">Silence Timeout (s)</label>
                            <input type="number" id="silenceTimeout" value="30" min="10" max="300" style="width: 100%; background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: var(--fg); padding: 10px 12px; border-radius: 10px;">
                        </div>
                    </div>
                    <div style="margin-bottom: 12px;">
                        <label style="font-size: 11px; color: var(--fg-dim); display: block; margin-bottom: 4px;">Target Conversation</label>
                        <select id="targetConversation" style="width: 100%; background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: var(--fg); padding: 10px 12px; border-radius: 10px;">
                            <option value="">Current (Active Tab)</option>
                        </select>
                        <div style="font-size: 10px; color: var(--fg-dim); margin-top: 4px;">Select which conversation receives the queue prompts.</div>
                    </div>
                    <div style="background: rgba(255,255,255,0.03); border-radius: 12px; padding: 14px; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.06);">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                            <span style="font-size: 12px;">Enable Check Prompt</span>
                            <label class="switch"><input type="checkbox" id="checkPromptEnabled"><span class="slider round"></span></label>
                        </div>
                        <div style="font-size: 10px; color: var(--fg-dim); margin-bottom: 8px;">Runs after each task to verify implementation quality.</div>
                        <textarea id="checkPromptText" style="min-height: 80px; font-size: 11px;" placeholder="Make sure the previous task was implemented fully..."></textarea>
                    </div>
                    <div style="background: rgba(255,255,255,0.03); border-radius: 12px; padding: 14px; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.06);">
                        <div style="display: flex; align-items: center; justify-content: space-between;">
                            <span style="font-size: 12px;">Resume on Quota Reset</span>
                            <label class="switch"><input type="checkbox" id="resumeEnabled" checked><span class="slider round"></span></label>
                        </div>
                        <div style="font-size: 10px; color: var(--fg-dim); margin-top: 8px;">Automatically resumes the queue when your quota becomes available again.</div>
                    </div>
                    <div id="queueStatusIndicator" style="text-align: center; padding: 12px; margin-bottom: 12px; border-radius: 12px; font-size: 12px; background: rgba(255,255,255,0.04); border: 1px solid var(--border);">
                        <span style="opacity: 0.6;">Queue Status:</span> <span id="queueStatusText" style="font-weight: 600;">Not Started</span>
                        <div id="currentPromptInfo" style="font-size: 10px; margin-top: 6px; opacity: 0.7; display: none;">Current: <span id="currentPromptText">-</span></div>
                    </div>
                    <div id="queueControlBtns" style="display: none; gap: 8px; margin-bottom: 12px;">
                        <button id="pauseQueueBtn" class="btn-outline" style="flex: 1; font-size: 12px; padding: 8px;">⏸ Pause</button>
                        <button id="skipPromptBtn" class="btn-outline" style="flex: 1; font-size: 12px; padding: 8px;">⏭ Skip</button>
                        <button id="stopQueueBtn" class="btn-danger" style="flex: 1; font-size: 12px; padding: 8px;">⏹ Stop</button>
                    </div>
                    <button id="startQueueBtn" class="btn-primary" style="width: 100%; background: var(--green);">▶ Save & Run Queue</button>
                    <div style="margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <label style="font-size: 11px; color: var(--fg-dim);">Recent Prompts</label>
                            <button id="refreshHistoryBtn" style="padding: 6px 10px; font-size: 11px; background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: var(--fg); border-radius: 10px; cursor: pointer;">↻ Refresh</button>
                        </div>
                        <div id="promptHistoryList" style="max-height: 120px; overflow-y: auto; font-size: 12px; background: rgba(255,255,255,0.03); border-radius: 12px; padding: 10px; border: 1px solid rgba(255,255,255,0.06);">
                            <div style="opacity: 0.5; text-align: center;">No prompts sent yet</div>
                        </div>
                    </div>
                </div>
                <div id="saveScheduleContainer"><button id="saveScheduleBtn" class="btn-primary" style="width: 100%;">Save Schedule</button></div>
            </div>
        </div>

        <div class="section">
            <div class="section-label">🛡️ Safety Rules</div>
            Patterns that will NEVER be antigravity-mpaed.
            <textarea id="bannedCommandsInput" placeholder="rm -rf /&#10;format c:&#10;del /f /s /q"></textarea>
            <div style="display: flex; gap: 12px; margin-top: 20px;">
                <button id="saveBannedBtn" class="btn-primary" style="flex: 2;">Update Rules</button>
                <button id="resetBannedBtn" class="btn-outline" style="flex: 1;">Reset</button>
            </div>
            <div id="bannedStatus" style="font-size: 12px; margin-top: 12px; text-align: center; height: 18px;"></div>
        </div>

        <div class="section">
            <div class="section-label">📊 Antigravity Quota</div>
            <div style="font-size: 13px; opacity: 0.6; margin-bottom: 16px; line-height: 1.5;">Monitor your AI model quotas and credits.</div>
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                <span style="font-size: 13px;">Show Quota in Status Bar</span>
                <label class="switch"><input type="checkbox" id="antigravityQuotaEnabled" checked><span class="slider round"></span></label>
            </div>
            <div style="display: flex; align-items: start; gap: 8px; margin-bottom: 16px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 12px;">
                <div style="padding-top: 2px;"><label class="switch" style="transform: scale(0.8); margin: 0;"><input type="checkbox" id="autoContinueEnabled"><span class="slider round"></span></label></div>
                <div>
                    <div style="font-size: 11px;">Auto-Continue Conversation</div>
                    <div style="font-size: 10px; color: var(--fg-dim); margin-top: 2px;">Automatically sends "Continue" when quota refreshes.</div>
                </div>
            </div>
            <div id="quotaStatusContainer" style="background: rgba(255,255,255,0.03); border-radius: 12px; padding: 16px; margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.06);">
                <div id="quotaStatusContent" style="text-align: center; font-size: 13px; opacity: 0.6;">Click refresh to check quota status</div>
            </div>
            <button id="refreshQuotaBtn" class="btn-outline" style="width: 100%;">Refresh Quota Status</button>
        </div>

        <div class="section">
            <div class="section-label">🔌 CDP Port</div>
            <div style="font-size: 13px; opacity: 0.6; margin-bottom: 16px; line-height: 1.5;">Chrome DevTools Protocol port for browser automation.</div>
            <div style="display: flex; align-items: center; gap: 12px;">
                <input type="number" id="cdpPortInput" min="1024" max="65535" value="9004" style="width: 100px; background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: var(--fg); padding: 8px 12px; border-radius: var(--radius-sm); font-size: 14px;">
                <button id="saveCdpPortBtn" class="btn-outline" style="padding: 8px 16px;">Save Port</button>
                <span id="cdpPortStatus" style="font-size: 12px; opacity: 0.6;"></span>
            </div>
        </div>

        <div class="section">
            <div class="section-label">
                <span>🔧 Debug Mode</span>
                <span id="debugBadge" class="badge" style="background:#ef4444; font-size: 10px; padding: 2px 6px;">ACTIVE</span>
            </div>
            <div style="font-size: 13px; opacity: 0.6; margin-bottom: 16px; line-height: 1.5;">Enable programmatic control of this extension via commands.</div>
            <div style="display: flex; align-items: center; justify-content: space-between;">
                <span style="font-size: 13px;">Enable Debug Mode</span>
                <label class="switch"><input type="checkbox" id="debugModeEnabled"><span class="slider round"></span></label>
            </div>
        </div>

        <div class="section">
            <div class="section-label">⚙️ Danger Zone</div>
            <div style="font-size: 13px; opacity: 0.6; margin-bottom: 16px;">Reset all settings and data.</div>
            <button id="resetAllBtn" class="btn-outline" style="width: 100%; color: #ef4444; border-color: rgba(239, 68, 68, 0.3);">Reset All Settings & Data</button>
        </div>

        <div class="section">
            <div class="section-label">🧾 Logs</div>
            <div style="display: flex; gap: 12px; margin-bottom: 12px;">
                <select id="logTailSelect" style="flex: 1; background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: var(--fg); padding: 10px 12px; border-radius: 10px;">
                    <option value="200">Last 200 lines</option>
                    <option value="300" selected>Last 300 lines</option>
                    <option value="500">Last 500 lines</option>
                    <option value="1000">Last 1000 lines</option>
                </select>
                <button id="refreshLogsBtn" class="btn-outline" style="flex: 1;">Refresh</button>
                <button id="copyLogsBtn" class="btn-outline" style="flex: 1;">Copy</button>
            </div>
            <div style="display: flex; gap: 12px; margin-bottom: 12px;">
                <button id="openLogsBtn" class="btn-primary" style="flex: 2;">Open File</button>
                <button id="clearLogsBtn" class="btn-outline" style="flex: 1;">Clear</button>
            </div>
            <textarea id="logsOutput" readonly style="min-height: 220px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;"></textarea>
            <div id="logsMeta" style="font-size: 11px; color: var(--fg-dim); margin-top: 10px;"></div>
        </div>

        <div class="footer">
            Built with ❤️ by <a href="https://github.com/hungpixi" target="_blank">hungpixi</a> | <a href="https://comarai.com" target="_blank">Comarai Agency</a>
        </div>
    </div>

    <script src="${jsUri}"></script>
</body>
</html>`;
    }

    dispose() {
        SettingsPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            if (d) d.dispose();
        }
    }
}

module.exports = { SettingsPanel };
