/**
 * CDP Auto-Discovery Module
 * 
 * Automatically finds the Chrome DevTools Protocol port for the running
 * Antigravity/Electron instance without requiring --remote-debugging-port flag.
 * 
 * Strategies (in priority order):
 * 1. DevToolsActivePort file — Most reliable when available
 * 2. Process arguments scan — Check if --remote-debugging-port was passed
 * 3. Netstat/port scan — Find listening CDP endpoints
 * 
 * Author: hungpixi (Comarai)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execSync } = require('child_process');

class CDPDiscovery {
    constructor(logger = console.log) {
        this.log = (msg) => logger(`[CDPDiscovery] ${msg}`);
        this.platform = os.platform();
        this._cachedPort = null;
        this._cacheTime = 0;
        this.CACHE_TTL = 30000; // Cache port for 30 seconds
    }

    /**
     * Main entry: Find the CDP port using all strategies
     * Returns the discovered port number, or null if not found
     */
    async discover() {
        // Check cache first
        if (this._cachedPort && (Date.now() - this._cacheTime) < this.CACHE_TTL) {
            // Verify cached port still works
            const alive = await this._probeCDP(this._cachedPort);
            if (alive) return this._cachedPort;
            this._cachedPort = null;
        }

        this.log('Starting CDP port discovery...');

        // Strategy 1: Check common/configured ports first (fast path)
        const quickPorts = [9004, 9222, 9229];
        for (const port of quickPorts) {
            const alive = await this._probeCDP(port);
            if (alive) {
                this.log(`Found CDP on common port: ${port}`);
                this._cachedPort = port;
                this._cacheTime = Date.now();
                return port;
            }
        }

        // Strategy 2: DevToolsActivePort file
        const filePort = this._readDevToolsActivePort();
        if (filePort) {
            const alive = await this._probeCDP(filePort);
            if (alive) {
                this.log(`Found CDP via DevToolsActivePort: ${filePort}`);
                this._cachedPort = filePort;
                this._cacheTime = Date.now();
                return filePort;
            }
        }

        // Strategy 3: Scan process arguments for --remote-debugging-port
        const argPort = this._scanProcessArgs();
        if (argPort) {
            const alive = await this._probeCDP(argPort);
            if (alive) {
                this.log(`Found CDP via process args: ${argPort}`);
                this._cachedPort = argPort;
                this._cacheTime = Date.now();
                return argPort;
            }
        }

        // Strategy 4: Netstat scan for Antigravity process
        const netstatPort = await this._scanNetstat();
        if (netstatPort) {
            this.log(`Found CDP via netstat: ${netstatPort}`);
            this._cachedPort = netstatPort;
            this._cacheTime = Date.now();
            return netstatPort;
        }

        this.log('All discovery strategies failed');
        return null;
    }

    /**
     * Strategy 1: Read DevToolsActivePort file
     * Electron writes this file when launched with --remote-debugging-port
     */
    _readDevToolsActivePort() {
        const possiblePaths = this._getDevToolsActivePortPaths();

        for (const fp of possiblePaths) {
            try {
                if (fs.existsSync(fp)) {
                    const content = fs.readFileSync(fp, 'utf8').trim();
                    const firstLine = content.split('\n')[0].trim();
                    const port = parseInt(firstLine, 10);
                    if (port > 0 && port < 65536) {
                        this.log(`DevToolsActivePort file found at ${fp}: port=${port}`);
                        return port;
                    }
                }
            } catch (e) {
                this.log(`Error reading ${fp}: ${e.message}`);
            }
        }

        return null;
    }

    /**
     * Get possible paths for DevToolsActivePort file
     */
    _getDevToolsActivePortPaths() {
        const paths = [];

        if (this.platform === 'win32') {
            const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
            const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

            // Antigravity specific paths
            paths.push(path.join(appData, 'Antigravity', 'DevToolsActivePort'));
            paths.push(path.join(localAppData, 'Antigravity', 'User Data', 'DevToolsActivePort'));
            paths.push(path.join(appData, 'antigravity', 'DevToolsActivePort'));

            // VS Code paths (fallback)
            paths.push(path.join(appData, 'Code', 'DevToolsActivePort'));
            paths.push(path.join(localAppData, 'Code', 'User Data', 'DevToolsActivePort'));
        } else if (this.platform === 'darwin') {
            const home = os.homedir();
            paths.push(path.join(home, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'));
            paths.push(path.join(home, 'Library', 'Application Support', 'Code', 'DevToolsActivePort'));
        } else {
            const home = os.homedir();
            paths.push(path.join(home, '.config', 'Antigravity', 'DevToolsActivePort'));
            paths.push(path.join(home, '.config', 'Code', 'DevToolsActivePort'));
        }

        return paths;
    }

    /**
     * Strategy 2: Scan current process args
     * If we're running inside the Electron process, check process.argv
     */
    _scanProcessArgs() {
        try {
            // Check current process first
            const args = process.argv.join(' ');
            const match = args.match(/--remote-debugging-port=(\d+)/);
            if (match) {
                const port = parseInt(match[1], 10);
                if (port > 0) {
                    this.log(`Found port in process.argv: ${port}`);
                    return port;
                }
            }

            // Check via shell command for Antigravity process
            if (this.platform === 'win32') {
                try {
                    const output = execSync(
                        'wmic process where "name like \'%Antigravity%\' or name like \'%electron%\'" get CommandLine /format:list',
                        { encoding: 'utf8', timeout: 5000, windowsHide: true }
                    );
                    const cmdMatch = output.match(/--remote-debugging-port=(\d+)/);
                    if (cmdMatch) {
                        const port = parseInt(cmdMatch[1], 10);
                        if (port > 0) {
                            this.log(`Found port in Antigravity process args: ${port}`);
                            return port;
                        }
                    }
                } catch (e) {
                    // WMIC might fail, try PowerShell
                    try {
                        const output = execSync(
                            'powershell -NoProfile -Command "Get-Process -Name *Antigravity*,*electron* -ErrorAction SilentlyContinue | ForEach-Object { (Get-CimInstance Win32_Process -Filter \\"ProcessId=$($_.Id)\\").CommandLine }"',
                            { encoding: 'utf8', timeout: 5000, windowsHide: true }
                        );
                        const psMatch = output.match(/--remote-debugging-port=(\d+)/);
                        if (psMatch) {
                            return parseInt(psMatch[1], 10);
                        }
                    } catch (e2) { /* ignore */ }
                }
            } else {
                // Unix: ps aux
                try {
                    const output = execSync(
                        "ps aux | grep -i 'antigravity\\|electron' | grep -v grep",
                        { encoding: 'utf8', timeout: 5000 }
                    );
                    const psMatch = output.match(/--remote-debugging-port=(\d+)/);
                    if (psMatch) {
                        return parseInt(psMatch[1], 10);
                    }
                } catch (e) { /* ignore */ }
            }
        } catch (e) {
            this.log(`Process args scan error: ${e.message}`);
        }

        return null;
    }

    /**
     * Strategy 3: Netstat scan — find CDP endpoints by testing ports
     * Looks for the Antigravity process PID and its listening ports
     */
    async _scanNetstat() {
        try {
            let candidatePorts = [];

            if (this.platform === 'win32') {
                // Get Antigravity PID first
                try {
                    const pidOutput = execSync(
                        'powershell -NoProfile -Command "(Get-Process -Name *Antigravity* -ErrorAction SilentlyContinue | Select-Object -First 1).Id"',
                        { encoding: 'utf8', timeout: 5000, windowsHide: true }
                    ).trim();

                    const pid = parseInt(pidOutput, 10);
                    if (pid > 0) {
                        this.log(`Found Antigravity PID: ${pid}`);
                        // Get listening ports for this PID
                        const netstatOutput = execSync(
                            `netstat -ano | findstr "LISTENING" | findstr "${pid}"`,
                            { encoding: 'utf8', timeout: 5000, windowsHide: true }
                        );
                        const portMatches = netstatOutput.matchAll(/:(\d+)\s+.*LISTENING/g);
                        for (const m of portMatches) {
                            const port = parseInt(m[1], 10);
                            if (port >= 1024 && port <= 65535) {
                                candidatePorts.push(port);
                            }
                        }
                    }
                } catch (e) {
                    this.log(`Windows PID scan failed: ${e.message}`);
                }
            } else {
                // Unix: lsof
                try {
                    const output = execSync(
                        "lsof -i -P -n | grep -i 'antigravity\\|electron' | grep LISTEN",
                        { encoding: 'utf8', timeout: 5000 }
                    );
                    const portMatches = output.matchAll(/:(\d+)\s+\(LISTEN\)/g);
                    for (const m of portMatches) {
                        candidatePorts.push(parseInt(m[1], 10));
                    }
                } catch (e) { /* ignore */ }
            }

            // Remove duplicates and sort
            candidatePorts = [...new Set(candidatePorts)].sort((a, b) => a - b);
            this.log(`Candidate ports from netstat: [${candidatePorts.join(', ')}]`);

            // Probe each candidate for CDP endpoint
            for (const port of candidatePorts) {
                const isCDP = await this._probeCDP(port);
                if (isCDP) return port;
            }
        } catch (e) {
            this.log(`Netstat scan error: ${e.message}`);
        }

        return null;
    }

    /**
     * Probe a port to check if it serves CDP (Chrome DevTools Protocol)
     * CDP endpoints respond to GET /json/list with a JSON array
     */
    _probeCDP(port) {
        return new Promise((resolve) => {
            const req = http.get(
                { hostname: '127.0.0.1', port, path: '/json/list', timeout: 800 },
                (res) => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => {
                        try {
                            const pages = JSON.parse(body);
                            if (Array.isArray(pages)) {
                                resolve(true);
                                return;
                            }
                        } catch (e) { /* not JSON */ }
                        resolve(false);
                    });
                }
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    }

    /**
     * Clear cached port (call when connection drops)
     */
    clearCache() {
        this._cachedPort = null;
        this._cacheTime = 0;
    }
}

module.exports = { CDPDiscovery };
