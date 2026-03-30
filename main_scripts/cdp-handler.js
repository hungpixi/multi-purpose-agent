const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { CDPDiscovery } = require('./cdp-discovery');

const DEFAULT_CDP_PORT = 9004;

class CDPHandler {
    constructor(logger = console.log, port = DEFAULT_CDP_PORT) {
        this.logger = logger;
        this.port = port;
        this.connections = new Map(); // port:pageId -> {ws, injected}
        this.isEnabled = false;
        this.msgId = 1;
        
        // Auto-discovery integration
        this.discovery = new CDPDiscovery(logger);
        this._discoveryAttempted = false;
        this._autoDiscoveryEnabled = true;
    }

    log(msg) {
        this.logger(`[CDP] ${msg}`);
    }

    /**
     * Check if the configured CDP port is active.
     * Now with auto-discovery: if configured port fails, try to find the real port.
     */
    async isCDPAvailable() {
        // Try configured port first (fast path)
        try {
            const pages = await this._getPages(this.port);
            if (pages.length > 0) return true;
        } catch (e) { /* configured port failed */ }

        // Auto-discovery: try to find the real CDP port
        if (this._autoDiscoveryEnabled) {
            const discoveredPort = await this.discovery.discover();
            if (discoveredPort && discoveredPort !== this.port) {
                this.log(`Auto-discovered CDP port: ${discoveredPort} (was: ${this.port})`);
                this.port = discoveredPort;
                try {
                    const pages = await this._getPages(this.port);
                    return pages.length > 0;
                } catch (e) { /* discovered port also failed */ }
            }
        }

        return false;
    }

    /**
     * Start/maintain the CDP connection and injection loop.
     * Now with auto-discovery built in.
     */
    async start(config) {
        this.isEnabled = true;
        if (config.port) this.port = config.port;
        this.workspaceName = config.workspaceName || null;
        this.log(`Connecting to CDP on port ${this.port}...`);
        if (this.workspaceName) {
            this.log(`Current workspace: ${this.workspaceName}`);
        }

        try {
            let pages = await this._getPages(this.port);
            
            // Auto-discovery: if no pages on configured port, try discovery
            if (pages.length === 0 && this._autoDiscoveryEnabled) {
                const discoveredPort = await this.discovery.discover();
                if (discoveredPort && discoveredPort !== this.port) {
                    this.log(`Auto-discover: switching from port ${this.port} to ${discoveredPort}`);
                    this.port = discoveredPort;
                    pages = await this._getPages(this.port);
                }
            }
            
            for (const page of pages) {
                const id = `${this.port}:${page.id}`;
                if (!this.connections.has(id)) {
                    await this._connect(id, page.webSocketDebuggerUrl);
                }
                if (this.connections.has(id)) {
                    this.connections.get(id).pageTitle = page.title || '';
                    this.connections.get(id).pageUrl = page.url || '';
                }
                await this._inject(id, config);
            }
        } catch (e) { }
    }

    async stop() {
        this.isEnabled = false;
        for (const [id, conn] of this.connections) {
            try {
                await this._evaluate(id, 'if(window.__autoAcceptStop) window.__autoAcceptStop()');
                conn.ws.close();
            } catch (e) { }
        }
        this.connections.clear();
        this.discovery.clearCache();
    }

    async _getPages(port) {
        return new Promise((resolve, reject) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/json/list', timeout: 500 }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        const pages = JSON.parse(body);
                        // Filter for debuggable pages with WebSocket
                        const filtered = pages.filter(p => {
                            if (!p.webSocketDebuggerUrl) return false;
                            if (p.type !== 'page' && p.type !== 'webview' && p.type !== 'iframe') return false;
                            // Exclude our Settings Panel webview
                            if (p.title && p.title.includes('Antigravity Multi Purpose Agent Settings')) return false;
                            return true;
                        });
                        resolve(filtered);
                    } catch (e) { resolve([]); }
                });
            });
            req.on('error', () => resolve([]));
            req.on('timeout', () => { req.destroy(); resolve([]); });
        });
    }

    async _connect(id, url) {
        return new Promise((resolve) => {
            const ws = new WebSocket(url);
            ws.on('open', () => {
                this.connections.set(id, { ws, injected: false });
                this.log(`Connected to page ${id}`);
                resolve(true);
            });
            ws.on('error', () => resolve(false));
            ws.on('close', () => {
                this.connections.delete(id);
                this.log(`Disconnected from page ${id}`);
            });
        });
    }

    async _inject(id, config) {
        const conn = this.connections.get(id);
        if (!conn) return;

        try {
            if (!conn.injected) {
                const scriptPath = path.join(__dirname, '..', 'main_scripts', 'full_cdp_script.js');
                const script = fs.readFileSync(scriptPath, 'utf8');
                // Initial injection can take longer due to the size of the script.
                await this._evaluate(id, script, 15000);
                conn.injected = true;
                this.log(`Script injected into ${id}`);
            }

            await this._evaluate(id, `if(window.__autoAcceptStart) window.__autoAcceptStart(${JSON.stringify(config)})`);
        } catch (e) {
            this.log(`Injection failed for ${id}: ${e.message}`);
        }
    }

    async _evaluate(id, expression, timeoutMs = 2000) {
        const conn = this.connections.get(id);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;

        return new Promise((resolve, reject) => {
            const currentId = this.msgId++;
            const timeout = setTimeout(() => reject(new Error('CDP Timeout')), timeoutMs);

            const onMessage = (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.id === currentId) {
                    conn.ws.off('message', onMessage);
                    clearTimeout(timeout);
                    resolve(msg.result);
                }
            };

            conn.ws.on('message', onMessage);
            conn.ws.send(JSON.stringify({
                id: currentId,
                method: 'Runtime.evaluate',
                params: { expression, userGesture: true, awaitPromise: true }
            }));
        });
    }

    /**
     * Public evaluate method for debug purposes.
     * Evaluates expression on ALL connections and returns the first successful result.
     */
    async evaluate(expression) {
        let lastResult = null;
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, expression);
                if (res) lastResult = res.result?.value;
            } catch (e) { }
        }
        return lastResult;
    }

    async getStats() {
        const stats = { clicks: 0, blocked: 0, fileEdits: 0, terminalCommands: 0 };
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, 'JSON.stringify(window.__autoAcceptGetStats ? window.__autoAcceptGetStats() : {})');
                if (res?.result?.value) {
                    const s = JSON.parse(res.result.value);
                    stats.clicks += s.clicks || 0;
                    stats.blocked += s.blocked || 0;
                    stats.fileEdits += s.fileEdits || 0;
                    stats.terminalCommands += s.terminalCommands || 0;
                }
            } catch (e) { }
        }
        return stats;
    }

    async getSessionSummary() { return this.getStats(); } // Compatibility
    async setFocusState(isFocused) {
        for (const [id] of this.connections) {
            try {
                await this._evaluate(id, `if(window.__autoAcceptSetFocusState) window.__autoAcceptSetFocusState(${isFocused})`);
            } catch (e) { }
        }
    }

    getConnectionCount() { return this.connections.size; }
    
    /**
     * Get the currently active CDP port (may have been auto-discovered)
     */
    getActivePort() { return this.port; }

    async sendPrompt(text, targetConversation = '') {
        if (!text) return 0;

        const connCount = this.connections.size;
        if (connCount === 0) {
            this.log(`ERROR: No CDP connections available! Cannot send prompt.`);
            return 0;
        }

        this.log(`Sending prompt to ${connCount} connection(s)${targetConversation ? ` (target: "${targetConversation}")` : ''}: "${text.substring(0, 50)}..."`);

        // Use the newest prompt-sending implementation (probe + verification).
        try {
            return await this._sendPromptV2(text, targetConversation);
        } catch (e) {
            this.log(`Prompt send (v2) failed: ${e?.message || String(e)}`);
            return 0;
        }
    }

    async _sendPromptV2(text, targetConversation = '') {
        if (!text) return 0;

        const connCount = this.connections.size;
        if (connCount === 0) return 0;

        // Probe each connection for the best prompt input target
        const connectionResults = [];
        for (const [id] of this.connections) {
            try {
                const probeRes = await this._evaluate(id, `(function(){
                    try {
                        if (typeof window !== "undefined" && window.__autoAcceptProbePrompt) {
                            return JSON.stringify(window.__autoAcceptProbePrompt());
                        }
                        // Fallback: basic scan (textarea or contenteditable)
                        const editables = document.querySelectorAll('[contenteditable="true"]');
                        const textareas = document.querySelectorAll('textarea');
                        const any = (editables && editables.length > 0) || (textareas && textareas.length > 0);
                        return JSON.stringify({ hasInput: !!any, score: any ? 1 : 0 });
                    } catch (e) {
                        return JSON.stringify({ hasInput: false, score: 0, error: (e && e.message) ? e.message : String(e) });
                    }
                })()`);

                const parsed = typeof probeRes?.result?.value === 'string'
                    ? JSON.parse(probeRes.result.value)
                    : { hasInput: false, score: 0 };

                connectionResults.push({
                    id,
                    hasInput: !!parsed.hasInput,
                    score: typeof parsed.score === 'number' ? parsed.score : 0,
                    details: parsed
                });
            } catch (e) {
                connectionResults.push({ id, hasInput: false, score: 0, error: e.message });
            }
        }

        let targetsWithInput = connectionResults.filter(r => r.hasInput);

        // Prefer the Antigravity agent chat webview when present.
        const agentPanelTargets = targetsWithInput.filter(r => r.details && r.details.hasAgentPanel);
        if (agentPanelTargets.length > 0) {
            targetsWithInput = agentPanelTargets;
        }

        // If workspace preference set, filter targets to matching workspace
        if (this.workspaceName && targetsWithInput.length > 1) {
            const workspaceMatches = targetsWithInput.filter(r => {
                const conn = this.connections.get(r.id);
                const title = conn?.pageTitle || '';
                return title.toLowerCase().includes(this.workspaceName.toLowerCase());
            });
            if (workspaceMatches.length > 0) {
                targetsWithInput = workspaceMatches;
            }
        }

        if (targetsWithInput.length === 0) {
            this.log('Prompt send (v2): No connection reports a prompt input.');
            return 0;
        }

        targetsWithInput.sort((a, b) => {
            const aPanel = a.details && a.details.hasAgentPanel ? 1 : 0;
            const bPanel = b.details && b.details.hasAgentPanel ? 1 : 0;
            if (aPanel !== bPanel) return bPanel - aPanel;
            return (b.score || 0) - (a.score || 0);
        });
        const target = targetsWithInput[0];
        this.log(`Prompt send (v2): Using ${target.id} (score: ${target.score || 0})`);

        try {
            const result = await this._evaluate(target.id, `(async function(){
                const out = { ok: false, method: null, error: null };
                try {
                    if(typeof window !== "undefined" && window.__autoAcceptSendPromptToConversation) {
                        const ok = await window.__autoAcceptSendPromptToConversation(${JSON.stringify(text)}, ${JSON.stringify(targetConversation)});
                        out.ok = !!ok;
                        out.method = 'sendPromptToConversation';
                        if(!out.ok) out.error = 'sendPromptToConversation returned falsy';
                        return JSON.stringify(out);
                    }
                    if(typeof window !== "undefined" && window.__autoAcceptSendPrompt) {
                        const ok = await window.__autoAcceptSendPrompt(${JSON.stringify(text)});
                        out.ok = !!ok;
                        out.method = 'sendPrompt';
                        if(!out.ok) out.error = 'sendPrompt returned falsy';
                        return JSON.stringify(out);
                    }
                    out.error = 'no send functions found';
                    return JSON.stringify(out);
                } catch (e) {
                    out.error = (e && e.message) ? e.message : String(e);
                    return JSON.stringify(out);
                }
            })()`, 15000);

            const raw = result?.result?.value;
            let parsed = null;
            if (typeof raw === 'string') {
                try { parsed = JSON.parse(raw); } catch (e) { }
            }

            if (parsed?.ok) {
                this.log(`Prompt send (v2): Sent via ${parsed.method}`);
                return 1;
            }

            this.log(`Prompt send (v2): NOT sent: ${parsed?.error || raw || 'unknown error'}`);
            return 0;
        } catch (e) {
            this.log(`Prompt send (v2): Failed to send: ${e.message}`);
            return 0;
        }
    }

    async getAwayActions() {
        let total = 0;
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, `(function(){ 
                    if(typeof window !== "undefined" && window.__autoAcceptGetAwayActions) {
                        return window.__autoAcceptGetAwayActions();
                    }
                    return 0; 
                })()`);

                if (res && res.result && res.result.value !== undefined) {
                    total += parseInt(res.result.value) || 0;
                }
            } catch (e) { }
        }
        return total;
    }

    async resetStats() {
        const aggregatedStats = { clicks: 0, blocked: 0 };
        for (const [id] of this.connections) {
            try {
                const jsonRes = await this._evaluate(id, `(function(){ 
                    if(typeof window !== "undefined" && window.__autoAcceptResetStats) {
                        return JSON.stringify(window.__autoAcceptResetStats());
                    }
                    return JSON.stringify({ clicks: 0, blocked: 0 });
                })()`);

                if (jsonRes && jsonRes.result && jsonRes.result.value) {
                    const s = JSON.parse(jsonRes.result.value);
                    aggregatedStats.clicks += s.clicks || 0;
                    aggregatedStats.blocked += s.blocked || 0;
                }
            } catch (e) {
                this.log(`Failed to reset stats for ${id}: ${e.message}`);
            }
        }
        return aggregatedStats;
    }
    async getConversations() {
        return await this._getConversationsRobust();
    }

    async getActiveConversation() {
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, `(function(){
                    try {
                        if (typeof window !== "undefined" && window.__autoAcceptGetActiveTabName) {
                            return window.__autoAcceptGetActiveTabName() || '';
                        }
                        return '';
                    } catch (e) {
                        return '';
                    }
                })()`);
                const val = res?.result?.value;
                if (typeof val === 'string' && val.trim()) {
                    return val.trim();
                }
            } catch (e) { }
        }
        return '';
    }

    async _getConversationsRobust() {
        const allTabs = new Set();
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id, 'JSON.stringify(window.__autoAcceptState ? window.__autoAcceptState.tabNames : [])');
                if (res?.result?.value) {
                    const tabs = JSON.parse(res.result.value);
                    if (Array.isArray(tabs)) {
                        tabs.forEach(t => allTabs.add(t));
                    }
                }
            } catch (e) { }
        }
        return Array.from(allTabs);
    }
}

module.exports = { CDPHandler };
