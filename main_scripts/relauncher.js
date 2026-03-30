const vscode = require('vscode');
const { execSync, spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const DEFAULT_CDP_PORT = 0; // Use 0 = auto-pick random available port

class Relauncher {
    constructor(logger = console.log, port = DEFAULT_CDP_PORT) {
        this.platform = os.platform();
        this.logger = logger;
        this.port = port;
        this.cdpFlag = port > 0 ? `--remote-debugging-port=${port}` : `--remote-debugging-port=0`;
    }

    log(msg) {
        this.logger(`[Relauncher] ${msg}`);
    }

    getIdeName() {
        const appName = vscode.env.appName || '';
        if (appName.toLowerCase().includes('antigravity')) return 'Antigravity';
        return 'Code';
    }

    /**
     * Main entry point: ensures CDP is enabled and relaunches if necessary.
     * Now defaults to silent mode — no user interaction needed.
     */
    async ensureCDPAndRelaunch() {
        this.log('Checking if CDP flag already present...');
        const hasFlag = await this.checkShortcutFlag();

        if (hasFlag) {
            this.log('CDP flag already present.');
            return { success: true, relaunched: false };
        }

        // Best effort: try to modify shortcut for future launches
        this.log('CDP flag missing. Attempting to modify shortcut...');
        const modified = await this.modifyShortcut();
        this.log(modified ? 'Shortcut modified.' : 'Shortcut modification failed (will use direct launch).');

        // Auto-restart without asking (silently)
        return await this.silentRelaunch();
    }

    /**
     * Silent relaunch — restart IDE with CDP flag WITHOUT asking user.
     * This is the key fix: no more popup, no more "Please launch with..."
     */
    async silentRelaunch() {
        this.log('Performing silent relaunch with CDP flag...');

        // Modify shortcut first for persistence
        await this.modifyShortcut();

        // Show a brief non-modal notification (auto-dismisses)
        vscode.window.showInformationMessage(
            'Multi Purpose Agent: Restarting to enable automation...',
        );

        // Wait a moment for the notification to show
        await new Promise(r => setTimeout(r, 500));

        await this.relaunch();
        return true;
    }

    /**
     * Check if the current launch has the CDP flag
     */
    async checkShortcutFlag() {
        const args = process.argv.join(' ');
        return args.includes('--remote-debugging-port=');
    }

    /**
     * Modify the primary launch shortcut for the current platform
     */
    async modifyShortcut() {
        try {
            if (this.platform === 'win32') return await this._modifyWindowsShortcut();
            if (this.platform === 'darwin') return await this._modifyMacOSShortcut();
            if (this.platform === 'linux') return await this._modifyLinuxShortcut();
        } catch (e) {
            this.log(`Modification error: ${e.message}`);
        }
        return false;
    }

    async _modifyWindowsShortcut() {
        const ideName = this.getIdeName();
        const port = this.port || 0;
        const script = `
$ErrorActionPreference = "SilentlyContinue"
$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [System.IO.Path]::Combine($env:USERPROFILE, "Desktop")
$StartMenuPath = [System.IO.Path]::Combine($env:APPDATA, "Microsoft", "Windows", "Start Menu", "Programs")

$Shortcuts = Get-ChildItem "$DesktopPath\\*.lnk", "$StartMenuPath\\*.lnk" -Recurse | Where-Object { $_.Name -like "*${ideName}*" }

$modified = $false
foreach ($file in $Shortcuts) {
    try {
        $shortcut = $WshShell.CreateShortcut($file.FullName)
        if ($shortcut.Arguments -notlike "*--remote-debugging-port=*") {
            $shortcut.Arguments = "--remote-debugging-port=${port} " + $shortcut.Arguments
            $shortcut.Save()
            $modified = $true
        }
    } catch {}
}
if ($modified) { Write-Output "MODIFIED" } else { Write-Output "NO_CHANGE" }
`;
        const result = this._runPowerShell(script);
        return result.includes('MODIFIED');
    }

    async _modifyMacOSShortcut() {
        const ideName = this.getIdeName();
        const binDir = path.join(os.homedir(), '.local', 'bin');
        const wrapperPath = path.join(binDir, `${ideName.toLowerCase()}-cdp`);

        if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

        const appPath = this.getIdeName() === 'Code' ? '/Applications/Visual Studio Code.app' : `/Applications/${ideName}.app`;
        const content = `#!/bin/bash\nopen -a "${appPath}" --args --remote-debugging-port=${this.port} "$@"`;

        fs.writeFileSync(wrapperPath, content, { mode: 0o755 });
        this.log(`Created macOS wrapper at ${wrapperPath}`);
        return true;
    }

    async _modifyLinuxShortcut() {
        const ideName = this.getIdeName().toLowerCase();
        const desktopPaths = [
            path.join(os.homedir(), '.local', 'share', 'applications', `${ideName}.desktop`),
            `/usr/share/applications/${ideName}.desktop`
        ];

        for (const p of desktopPaths) {
            if (fs.existsSync(p)) {
                let content = fs.readFileSync(p, 'utf8');
                if (!content.includes('--remote-debugging-port=')) {
                    content = content.replace(/^Exec=(.*)$/m, `Exec=$1 --remote-debugging-port=${this.port}`);
                    const userPath = path.join(os.homedir(), '.local', 'share', 'applications', path.basename(p));
                    fs.mkdirSync(path.dirname(userPath), { recursive: true });
                    fs.writeFileSync(userPath, content);
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Relaunch the IDE with the CDP flag explicitly.
     * Uses pure PowerShell to survive process death on Windows (no CMD popup).
     */
    async relaunch() {
        const folders = (vscode.workspace.workspaceFolders || []).map(f => `"${f.uri.fsPath}"`).join(' ');

        if (this.platform === 'win32') {
            // Find the actual Antigravity.exe — search multiple possible locations
            let launchExe = '';
            const localAppData = process.env.LOCALAPPDATA || '';
            const candidates = [
                path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
                path.join(localAppData, 'Antigravity', 'Antigravity.exe'),
                path.join(process.env.PROGRAMFILES || '', 'Antigravity', 'Antigravity.exe'),
                path.join(process.env['PROGRAMFILES(X86)'] || '', 'Antigravity', 'Antigravity.exe'),
            ];
            
            for (const candidate of candidates) {
                if (candidate && fs.existsSync(candidate)) {
                    launchExe = candidate;
                    break;
                }
            }
            
            // Fallback: use process.execPath if no Antigravity.exe found
            if (!launchExe) {
                launchExe = process.execPath;
                // If execPath points to electron deep inside, try to find the main exe
                const exeDir = path.dirname(launchExe);
                const parentExe = path.join(path.dirname(exeDir), 'Antigravity.exe');
                if (fs.existsSync(parentExe)) {
                    launchExe = parentExe;
                }
            }
            
            this.log(`Launch exe: ${launchExe}`);
            
            // Pure PowerShell approach — NO batch file, NO CMD window
            // Start-Process with -WindowStyle Hidden ensures zero visual artifacts
            const folderArgs = folders ? ` ${folders}` : '';
            const psCommand = `Start-Process -FilePath '${launchExe.replace(/'/g, "''")}' -ArgumentList '${this.cdpFlag}${folderArgs}' -WindowStyle Normal`;
            
            // Use a PowerShell script that sleeps then launches — fully detached
            const psScript = [
                '$ErrorActionPreference = "SilentlyContinue"',
                'Start-Sleep -Seconds 3',
                psCommand
            ].join('; ');
            
            this.log(`Relaunch PS: ${psScript}`);
            
            // Spawn PowerShell completely hidden and detached
            const child = spawn('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
                '-ExecutionPolicy', 'Bypass', '-Command', psScript
            ], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true  // Critical: prevents ANY window from showing
            });
            child.unref();
            
        } else if (this.platform === 'darwin') {
            const ideName = this.getIdeName();
            const appPath = ideName === 'Code' ? '/Applications/Visual Studio Code.app' : `/Applications/${ideName}.app`;
            const cmd = `sleep 3 && open -a "${appPath}" --args ${this.cdpFlag} ${folders}`;
            spawn('sh', ['-c', cmd], { detached: true, stdio: 'ignore' }).unref();
        } else {
            const cmd = `sleep 3 && ${this.getIdeName().toLowerCase()} ${this.cdpFlag} ${folders}`;
            spawn('sh', ['-c', cmd], { detached: true, stdio: 'ignore' }).unref();
        }

        // Quit after giving the detached process time to start
        setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 1000);
    }

    _runPowerShell(script) {
        try {
            const tempFile = path.join(os.tmpdir(), `relaunch_${Date.now()}.ps1`);
            fs.writeFileSync(tempFile, script, 'utf8');
            const result = execSync(`powershell -ExecutionPolicy Bypass -File "${tempFile}"`, { encoding: 'utf8' });
            fs.unlinkSync(tempFile);
            return result;
        } catch (e) {
            return '';
        }
    }
}

module.exports = { Relauncher };
