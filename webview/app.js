/**
 * MPA v3.0 PROMAX — Dashboard Client App
 * Extracted from settings-panel.js monolith
 * Runs inside the WebView context
 */

const vscode = acquireVsCodeApi();

// ============================================================
// 1. POLLING — Real-time refresh
// ============================================================
function refreshStats() {
    vscode.postMessage({ command: 'getStats' });
    vscode.postMessage({ command: 'getROIStats' });
    vscode.postMessage({ command: 'getQueueStatus' });
    vscode.postMessage({ command: 'getConversations' });
    vscode.postMessage({ command: 'getPromptHistory' });
}

const refreshInterval = setInterval(refreshStats, 5000);

// ============================================================
// 2. PERFORMANCE SLIDER
// ============================================================
const slider = document.getElementById('freqSlider');
const valDisplay = document.getElementById('freqVal');

if (slider) {
    slider.addEventListener('input', (e) => {
        const s = (e.target.value / 1000).toFixed(1) + 's';
        valDisplay.innerText = s;
        vscode.postMessage({ command: 'setFrequency', value: e.target.value });
    });
}

// ============================================================
// 3. DEBUG MODE
// ============================================================
const debugModeCheckbox = document.getElementById('debugModeEnabled');
const debugBadge = document.getElementById('debugBadge');
if (debugModeCheckbox) {
    debugModeCheckbox.addEventListener('change', (e) => {
        vscode.postMessage({ command: 'setDebugMode', value: e.target.checked });
        if (debugBadge) {
            debugBadge.style.display = e.target.checked ? 'inline' : 'none';
        }
    });
}
vscode.postMessage({ command: 'getDebugMode' });

// ============================================================
// 4. CDP PORT
// ============================================================
const cdpPortInput = document.getElementById('cdpPortInput');
const saveCdpPortBtn = document.getElementById('saveCdpPortBtn');
const cdpPortStatus = document.getElementById('cdpPortStatus');

if (saveCdpPortBtn && cdpPortInput) {
    saveCdpPortBtn.addEventListener('click', () => {
        const port = parseInt(cdpPortInput.value, 10);
        if (port >= 1024 && port <= 65535) {
            vscode.postMessage({ command: 'setCdpPort', value: port });
            cdpPortStatus.textContent = 'Saved! Restart required.';
            cdpPortStatus.style.color = '#34d399';
            setTimeout(() => { cdpPortStatus.textContent = ''; }, 3000);
        } else {
            cdpPortStatus.textContent = 'Invalid port (1024-65535)';
            cdpPortStatus.style.color = '#fb7185';
        }
    });
}
vscode.postMessage({ command: 'getCdpPort' });

// ============================================================
// 5. BANNED COMMANDS (Safety Rules)
// ============================================================
const bannedInput = document.getElementById('bannedCommandsInput');
const saveBannedBtn = document.getElementById('saveBannedBtn');
const resetBannedBtn = document.getElementById('resetBannedBtn');
const bannedStatus = document.getElementById('bannedStatus');

const defaultBannedCommands = ["rm -rf /", "rm -rf ~", "rm -rf *", "format c:", "del /f /s /q", "rmdir /s /q", ":(){:|:&};:", "dd if=", "mkfs.", "> /dev/sda", "chmod -R 777 /"];

if (saveBannedBtn) {
    saveBannedBtn.addEventListener('click', () => {
        const lines = bannedInput.value.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        vscode.postMessage({ command: 'updateBannedCommands', commands: lines });
        bannedStatus.innerText = '✓ Safety Rules Updated';
        bannedStatus.style.color = 'var(--green)';
        setTimeout(() => { bannedStatus.innerText = ''; }, 3000);
    });
}

if (resetBannedBtn) {
    resetBannedBtn.addEventListener('click', () => {
        bannedInput.value = defaultBannedCommands.join('\n');
        vscode.postMessage({ command: 'updateBannedCommands', commands: defaultBannedCommands });
        bannedStatus.innerText = '✓ Defaults Restored';
        bannedStatus.style.color = 'var(--accent)';
        setTimeout(() => { bannedStatus.innerText = ''; }, 3000);
    });
}

// ============================================================
// 6. PROMPT QUEUE
// ============================================================
let currentPrompts = [];

const scheduleEnabled = document.getElementById('scheduleEnabled');
const scheduleControls = document.getElementById('scheduleControls');
const scheduleMode = document.getElementById('scheduleMode');
const scheduleValue = document.getElementById('scheduleValue');
const schedulePrompt = document.getElementById('schedulePrompt');
const singlePromptSection = document.getElementById('singlePromptSection');
const queueModeSection = document.getElementById('queueModeSection');

const promptList = document.getElementById('promptList');
const newPromptInput = document.getElementById('newPromptInput');
const addPromptBtn = document.getElementById('addPromptBtn');

const queueModeSelect = document.getElementById('queueMode');
const silenceTimeoutInput = document.getElementById('silenceTimeout');
const checkPromptEnabled = document.getElementById('checkPromptEnabled');
const checkPromptText = document.getElementById('checkPromptText');
const resumeEnabled = document.getElementById('resumeEnabled');
const autoContinueEnabled = document.getElementById('autoContinueEnabled');
const startQueueBtn = document.getElementById('startQueueBtn');
const saveScheduleBtn = document.getElementById('saveScheduleBtn');

// --- Render Prompts List ---
function renderPrompts() {
    if (!promptList) return;
    promptList.innerHTML = '';
    if (currentPrompts.length === 0) {
        promptList.innerHTML = '<div class="prompt-empty">Queue is empty</div>';
        return;
    }

    currentPrompts.forEach((text, index) => {
        const item = document.createElement('div');
        item.className = 'prompt-item';
        item.draggable = true;
        item.dataset.index = index;
        item.innerHTML = `
            <div class="prompt-handle">☰</div>
            <div class="prompt-content">${text}</div>
            <div class="prompt-delete" title="Remove">×</div>
        `;

        item.querySelector('.prompt-delete').onclick = (e) => {
            e.stopPropagation();
            currentPrompts.splice(index, 1);
            renderPrompts();
        };

        item.addEventListener('dragstart', handleDragStart);
        item.addEventListener('dragover', handleDragOver);
        item.addEventListener('drop', handleDrop);
        item.addEventListener('dragend', handleDragEnd);

        promptList.appendChild(item);
    });
}

// --- Add Prompt ---
function addNewPrompt() {
    if (!newPromptInput) return;
    const text = newPromptInput.value.trim();
    if (text) {
        currentPrompts.push(text);
        newPromptInput.value = '';
        renderPrompts();
    }
}

if (addPromptBtn) addPromptBtn.addEventListener('click', addNewPrompt);
if (newPromptInput) {
    newPromptInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addNewPrompt();
    });
}

// --- Drag & Drop ---
let dragSrcEl = null;
function handleDragStart(e) {
    dragSrcEl = this;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', this.dataset.index);
    this.classList.add('dragging');
}
function handleDragOver(e) {
    if (e.preventDefault) e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    return false;
}
function handleDrop(e) {
    if (e.stopPropagation) e.stopPropagation();
    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
    const toIndex = parseInt(this.dataset.index);
    if (dragSrcEl !== this && !isNaN(fromIndex) && !isNaN(toIndex)) {
        const item = currentPrompts.splice(fromIndex, 1)[0];
        currentPrompts.splice(toIndex, 0, item);
        renderPrompts();
    }
    return false;
}
function handleDragEnd() {
    this.classList.remove('dragging');
}

// --- Schedule Controls ---
const saveScheduleContainer = document.getElementById('saveScheduleContainer');
const queueStatusText = document.getElementById('queueStatusText');
const targetConversationSelect = document.getElementById('targetConversation');
const refreshHistoryBtn = document.getElementById('refreshHistoryBtn');
const promptHistoryList = document.getElementById('promptHistoryList');

if (targetConversationSelect) {
    targetConversationSelect.addEventListener('change', (e) => {
        vscode.postMessage({ command: 'setTargetConversation', value: e.target.value });
    });
}

if (refreshHistoryBtn) {
    refreshHistoryBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'getPromptHistory' });
        vscode.postMessage({ command: 'getConversations' });
    });
}

function updateModeVisibility() {
    const mode = scheduleMode ? scheduleMode.value : 'interval';
    if (singlePromptSection) singlePromptSection.style.display = mode === 'queue' ? 'none' : 'block';
    if (queueModeSection) queueModeSection.style.display = mode === 'queue' ? 'block' : 'none';
    if (saveScheduleContainer) saveScheduleContainer.style.display = mode === 'queue' ? 'none' : 'block';
}

if (scheduleEnabled) {
    scheduleEnabled.addEventListener('change', (e) => {
        const enabled = e.target.checked;
        if (scheduleControls) {
            scheduleControls.style.opacity = enabled ? '1' : '0.5';
            scheduleControls.style.pointerEvents = enabled ? 'auto' : 'none';
        }
    });
}

if (scheduleMode) scheduleMode.addEventListener('change', updateModeVisibility);

// --- Start Queue ---
if (startQueueBtn) {
    startQueueBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (e.isTrusted === false) {
            console.warn('StartQueue: Ignored untrusted click event');
            return;
        }

        if (startQueueBtn.disabled) return;
        const originalText = startQueueBtn.innerText;

        if (currentPrompts.length === 0) {
            startQueueBtn.innerText = '⚠️ Queue is Empty!';
            startQueueBtn.style.color = '#ef4444';
            startQueueBtn.style.borderColor = '#ef4444';
            setTimeout(() => {
                startQueueBtn.innerText = originalText;
                startQueueBtn.style.color = '';
                startQueueBtn.style.borderColor = '';
                startQueueBtn.disabled = false;
            }, 2000);
            return;
        }

        startQueueBtn.innerText = '⏳ Saving & Starting...';
        startQueueBtn.disabled = true;
        startQueueBtn.style.opacity = '0.7';
        startQueueBtn.style.cursor = 'wait';

        const schedule = {
            enabled: scheduleEnabled ? scheduleEnabled.checked : true,
            mode: scheduleMode ? scheduleMode.value : 'queue',
            value: scheduleValue ? scheduleValue.value : '30',
            prompt: schedulePrompt ? schedulePrompt.value : '',
            prompts: currentPrompts,
            queueMode: queueModeSelect ? queueModeSelect.value : 'consume',
            silenceTimeout: silenceTimeoutInput ? parseInt(silenceTimeoutInput.value) : 30,
            checkPromptEnabled: checkPromptEnabled ? checkPromptEnabled.checked : false,
            checkPromptText: checkPromptText ? checkPromptText.value : '',
            resumeEnabled: resumeEnabled ? resumeEnabled.checked : true,
            autoContinueEnabled: autoContinueEnabled ? autoContinueEnabled.checked : false
        };

        vscode.postMessage({ command: 'saveAndStartQueue', schedule });

        setTimeout(() => {
            startQueueBtn.innerText = originalText;
            startQueueBtn.disabled = false;
            startQueueBtn.style.opacity = '1';
            startQueueBtn.style.cursor = 'pointer';
        }, 2500);
    });
}

if (resumeEnabled) {
    resumeEnabled.addEventListener('change', (e) => {
        vscode.postMessage({ command: 'setResumeEnabled', value: e.target.checked });
    });
}

if (autoContinueEnabled) {
    autoContinueEnabled.addEventListener('change', (e) => {
        vscode.postMessage({ command: 'setAutoContinue', value: e.target.checked });
    });
}

// --- Queue Controls ---
const pauseQueueBtn = document.getElementById('pauseQueueBtn');
const skipPromptBtn = document.getElementById('skipPromptBtn');
const stopQueueBtn = document.getElementById('stopQueueBtn');

if (pauseQueueBtn) {
    pauseQueueBtn.addEventListener('click', () => {
        const isPaused = pauseQueueBtn.textContent.includes('Resume');
        vscode.postMessage({ command: isPaused ? 'resumeQueue' : 'pauseQueue' });
    });
}
if (skipPromptBtn) {
    skipPromptBtn.addEventListener('click', () => vscode.postMessage({ command: 'skipPrompt' }));
}
if (stopQueueBtn) {
    stopQueueBtn.addEventListener('click', () => vscode.postMessage({ command: 'stopQueue' }));
}

// --- Save Schedule (non-queue modes) ---
if (saveScheduleBtn) {
    saveScheduleBtn.addEventListener('click', () => {
        vscode.postMessage({
            command: 'updateSchedule',
            enabled: scheduleEnabled ? scheduleEnabled.checked : true,
            mode: scheduleMode ? scheduleMode.value : 'interval',
            value: scheduleValue ? scheduleValue.value : '30',
            prompt: schedulePrompt ? schedulePrompt.value : '',
            prompts: currentPrompts,
            queueMode: queueModeSelect ? queueModeSelect.value : 'consume',
            silenceTimeout: silenceTimeoutInput ? parseInt(silenceTimeoutInput.value) : 30,
            checkPromptEnabled: checkPromptEnabled ? checkPromptEnabled.checked : false,
            checkPromptText: checkPromptText ? checkPromptText.value : '',
            resumeEnabled: resumeEnabled ? resumeEnabled.checked : true,
            autoContinueEnabled: autoContinueEnabled ? autoContinueEnabled.checked : false
        });
        const originalText = saveScheduleBtn.innerText;
        saveScheduleBtn.innerText = '✓ Saved';
        saveScheduleBtn.style.background = 'var(--green)';
        setTimeout(() => {
            saveScheduleBtn.innerText = originalText;
            saveScheduleBtn.style.background = 'var(--accent)';
        }, 2000);
    });
}

updateModeVisibility();

// ============================================================
// 7. LOGS
// ============================================================
const logsOutput = document.getElementById('logsOutput');
const logsMeta = document.getElementById('logsMeta');
const refreshLogsBtn = document.getElementById('refreshLogsBtn');
const copyLogsBtn = document.getElementById('copyLogsBtn');
const openLogsBtn = document.getElementById('openLogsBtn');
const clearLogsBtn = document.getElementById('clearLogsBtn');
const logTailSelect = document.getElementById('logTailSelect');

function requestLogs() {
    const tailLines = logTailSelect ? logTailSelect.value : 300;
    vscode.postMessage({ command: 'getLogs', tailLines });
}

if (refreshLogsBtn) refreshLogsBtn.addEventListener('click', requestLogs);
if (openLogsBtn) openLogsBtn.addEventListener('click', () => vscode.postMessage({ command: 'openLogFile' }));
if (clearLogsBtn) clearLogsBtn.addEventListener('click', () => vscode.postMessage({ command: 'clearLogs' }));
if (logTailSelect) logTailSelect.addEventListener('change', requestLogs);

// ============================================================
// 8. MISC
// ============================================================
const resetAllBtn = document.getElementById('resetAllBtn');
if (resetAllBtn) {
    resetAllBtn.addEventListener('click', () => vscode.postMessage({ command: 'resetAllSettings' }));
}

const antigravityQuotaCheckbox = document.getElementById('antigravityQuotaEnabled');
const refreshQuotaBtn = document.getElementById('refreshQuotaBtn');
const quotaStatusContent = document.getElementById('quotaStatusContent');

if (antigravityQuotaCheckbox) {
    antigravityQuotaCheckbox.addEventListener('change', (e) => {
        vscode.postMessage({ command: 'setAntigravityQuota', value: e.target.checked });
    });
}
if (refreshQuotaBtn) {
    refreshQuotaBtn.addEventListener('click', () => {
        quotaStatusContent.innerHTML = '<span style="opacity:0.5">Fetching...</span>';
        vscode.postMessage({ command: 'refreshAntigravityQuota' });
    });
}
vscode.postMessage({ command: 'getAntigravityQuota' });

if (copyLogsBtn) {
    copyLogsBtn.addEventListener('click', async () => {
        try {
            const text = logsOutput ? logsOutput.value : '';
            await navigator.clipboard.writeText(text);
            const originalText = copyLogsBtn.innerText;
            copyLogsBtn.innerText = '✓ Copied';
            copyLogsBtn.style.borderColor = 'var(--green)';
            copyLogsBtn.style.color = 'var(--green)';
            setTimeout(() => {
                copyLogsBtn.innerText = originalText;
                copyLogsBtn.style.borderColor = 'rgba(255,255,255,0.2)';
                copyLogsBtn.style.color = 'rgba(255,255,255,0.8)';
            }, 1500);
        } catch (e) { /* clipboard not available */ }
    });
}

// ============================================================
// 9. COUNT-UP ANIMATION
// ============================================================
function animateCountUp(element, target, duration = 1200, suffix = '') {
    const currentVal = parseInt(element.innerText.replace(/[^0-9]/g, '')) || 0;
    if (currentVal === target && !suffix) return;

    const startTime = performance.now();
    function easeOutExpo(t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const current = Math.round(currentVal + (target - currentVal) * easeOutExpo(progress));
        element.innerText = current + suffix;
        if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
}

// ============================================================
// 10. MESSAGE HANDLER — Receive data from extension
// ============================================================
window.addEventListener('message', e => {
    const msg = e.data;

    if (msg.command === 'updateStats') {
        if (slider) {
            slider.value = msg.frequency;
            valDisplay.innerText = (msg.frequency / 1000).toFixed(1) + 's';
        }
    }
    if (msg.command === 'updateROIStats') {
        const roi = msg.roiStats;
        if (roi) {
            animateCountUp(document.getElementById('roiClickCount'), roi.clicksThisWeek || 0);
            animateCountUp(document.getElementById('roiSessionCount'), roi.sessionsThisWeek || 0);
            animateCountUp(document.getElementById('roiBlockedCount'), roi.blockedThisWeek || 0);
            document.getElementById('roiTimeSaved').innerText = roi.timeSavedFormatted || '0m';
        }
    }
    if (msg.command === 'updateDebugMode') {
        if (debugModeCheckbox) debugModeCheckbox.checked = msg.enabled;
        if (debugBadge) debugBadge.style.display = msg.enabled ? 'inline' : 'none';
    }
    if (msg.command === 'updateCdpPort') {
        if (cdpPortInput) cdpPortInput.value = msg.port;
    }
    if (msg.command === 'updateBannedCommands') {
        if (bannedInput && msg.bannedCommands) {
            bannedInput.value = msg.bannedCommands.join('\n');
        }
    }
    if (msg.command === 'updateSchedule') {
        if (msg.schedule) {
            if (scheduleEnabled) scheduleEnabled.checked = msg.schedule.enabled;
            if (scheduleMode) scheduleMode.value = msg.schedule.mode || 'interval';
            if (scheduleValue) scheduleValue.value = msg.schedule.value || '30';
            if (schedulePrompt) schedulePrompt.value = msg.schedule.prompt || '';

            if (msg.schedule.prompts) {
                currentPrompts = Array.isArray(msg.schedule.prompts) ? msg.schedule.prompts : [];
                renderPrompts();
            } else {
                currentPrompts = [];
                renderPrompts();
            }

            if (queueModeSelect) queueModeSelect.value = msg.schedule.queueMode || 'consume';
            if (silenceTimeoutInput) silenceTimeoutInput.value = msg.schedule.silenceTimeout || 30;
            if (checkPromptEnabled) checkPromptEnabled.checked = msg.schedule.checkPromptEnabled || false;
            if (checkPromptText) checkPromptText.value = msg.schedule.checkPromptText || '';
            if (resumeEnabled) resumeEnabled.checked = msg.schedule.resumeEnabled !== false;
            if (autoContinueEnabled) autoContinueEnabled.checked = msg.schedule.autoContinueEnabled === true;

            if (scheduleControls) {
                scheduleControls.style.opacity = msg.schedule.enabled ? '1' : '0.5';
                scheduleControls.style.pointerEvents = msg.schedule.enabled ? 'auto' : 'none';
            }
            updateModeVisibility();
        }
    }
    if (msg.command === 'updateLogs') {
        if (logsOutput) logsOutput.value = msg.logs || '';
        if (logsMeta) {
            const meta = msg.meta || {};
            if (meta.exists === false) {
                logsMeta.innerText = 'Log file not found yet. Turn Multi Purpose Agent ON to generate logs.';
            } else if (meta.exists === true) {
                const kb = meta.size ? Math.round(meta.size / 1024) : 0;
                logsMeta.innerText = (meta.linesShown || 0) + ' lines • ' + kb + ' KB • ' + (meta.filePath || '');
            } else {
                logsMeta.innerText = meta.filePath ? meta.filePath : '';
            }
        }
    }
    if (msg.command === 'updateAntigravityQuotaEnabled') {
        if (antigravityQuotaCheckbox) antigravityQuotaCheckbox.checked = msg.enabled !== false;
    }
    if (msg.command === 'updateAntigravityQuotaStatus') {
        if (quotaStatusContent) {
            if (msg.error) {
                quotaStatusContent.innerHTML = '<span style="color:#ef4444">Error: ' + msg.error + '</span>';
            } else if (msg.snapshot) {
                let html = '';
                if (msg.snapshot.user) {
                    html += '<div style="margin-bottom:8px"><strong>' + (msg.snapshot.user.name || msg.snapshot.user.email || 'User') + '</strong> (' + (msg.snapshot.user.plan || 'Unknown Plan') + ')</div>';
                }
                if (msg.snapshot.models && msg.snapshot.models.length > 0) {
                    html += '<div style="text-align:left">';
                    const sortedModels = [...msg.snapshot.models].sort((a, b) => {
                        if (a.isExhausted && !b.isExhausted) return -1;
                        if (!a.isExhausted && b.isExhausted) return 1;
                        return (a.remainingPercentage || 100) - (b.remainingPercentage || 100);
                    });
                    sortedModels.slice(0, 10).forEach(m => {
                        const pct = m.remainingPercentage !== undefined ? m.remainingPercentage.toFixed(0) + '%' : '0%';
                        const icon = m.isExhausted ? '🔴' : (m.remainingPercentage < 20 ? '🟡' : '🟢');
                        const resetInfo = m.timeUntilResetFormatted ? ' <span style="opacity:0.5;font-size:11px"> - ' + m.timeUntilResetFormatted + '</span>' : '';
                        html += '<div style="margin:4px 0">' + icon + ' ' + m.label + ': ' + pct + resetInfo + '</div>';
                    });
                    if (sortedModels.length > 10) {
                        html += '<div style="opacity:0.5;font-size:11px;margin-top:4px">...and ' + (sortedModels.length - 10) + ' more</div>';
                    }
                    html += '</div>';
                } else if (msg.snapshot.promptCredits) {
                    const pc = msg.snapshot.promptCredits;
                    html += '<div>Credits: ' + pc.available + ' / ' + pc.monthly + ' (' + pc.remainingPercentage.toFixed(0) + '%)</div>';
                }
                quotaStatusContent.innerHTML = html || 'Connected';
            } else {
                quotaStatusContent.innerHTML = '<span style="opacity:0.5">Not connected</span>';
            }
        }
    }
    if (msg.command === 'updateQueueStatus') {
        if (queueStatusText && msg.status) {
            const s = msg.status;
            let statusText = 'Not Started';
            let statusColor = 'inherit';

            if (s.isQuotaExhausted) {
                statusText = 'Paused (Quota)'; statusColor = '#f59e0b';
            } else if (s.isPaused) {
                statusText = 'Paused (' + (s.queueIndex + 1) + '/' + s.queueLength + ')'; statusColor = '#f59e0b';
            } else if (s.conversationStatus === 'waiting') {
                statusText = 'Waiting (Busy)'; statusColor = '#f59e0b';
            } else if (s.isRunningQueue) {
                statusText = 'Running (' + (s.queueIndex + 1) + '/' + s.queueLength + ')'; statusColor = '#22c55e';
            } else if (s.queueLength > 0) {
                statusText = 'Ready (' + s.queueLength + ' items)'; statusColor = '#3b82f6';
            }

            queueStatusText.innerText = statusText;
            queueStatusText.style.color = statusColor;

            const controlBtns = document.getElementById('queueControlBtns');
            const startBtn = document.getElementById('startQueueBtn');
            const pauseBtn = document.getElementById('pauseQueueBtn');
            const currentPromptInfo = document.getElementById('currentPromptInfo');
            const currentPromptTextEl = document.getElementById('currentPromptText');

            if (controlBtns && startBtn) {
                if (s.isRunningQueue) {
                    controlBtns.style.display = 'flex';
                    startBtn.style.display = 'none';
                } else {
                    controlBtns.style.display = 'none';
                    startBtn.style.display = 'block';
                }
            }
            if (pauseBtn) {
                pauseBtn.textContent = s.isPaused ? '▶ Resume' : '⏸ Pause';
            }
            if (currentPromptInfo && s.currentPrompt) {
                currentPromptInfo.style.display = 'block';
                if (currentPromptTextEl) {
                    currentPromptTextEl.textContent = s.currentPrompt.text.substring(0, 40) + '...';
                }
            } else if (currentPromptInfo) {
                currentPromptInfo.style.display = 'none';
            }
        }
    }
    if (msg.command === 'updateConversations') {
        if (targetConversationSelect && msg.conversations) {
            const currentValue = targetConversationSelect.value;
            targetConversationSelect.innerHTML = '<option value="">Current (Active Tab)</option>';
            msg.conversations.forEach(conv => {
                const option = document.createElement('option');
                option.value = conv;
                option.textContent = conv;
                if (conv === currentValue) option.selected = true;
                targetConversationSelect.appendChild(option);
            });
        }
    }
    if (msg.command === 'updatePromptHistory') {
        if (promptHistoryList && msg.history) {
            if (msg.history.length === 0) {
                promptHistoryList.innerHTML = '<div style="opacity: 0.5; text-align: center;">No prompts sent yet</div>';
            } else {
                let html = '';
                msg.history.slice(-10).reverse().forEach(h => {
                    const convLabel = h.conversation === 'current' || !h.conversation ? '' : ' [' + h.conversation.substring(0, 15) + ']';
                    html += '<div style="padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">';
                    html += '<span style="opacity: 0.5; font-size: 10px;">' + h.timeAgo + convLabel + '</span> ';
                    html += '<span>' + h.text.substring(0, 60) + (h.text.length > 60 ? '...' : '') + '</span>';
                    html += '</div>';
                });
                promptHistoryList.innerHTML = html;
            }
        }
    }

    // === Debug UI Bridge ===
    if (msg.command === 'executeDebugUIAction') {
        const action = msg.action || {};
        let result = { success: false, error: 'Unknown action' };
        try {
            switch (action.type) {
                case 'click': {
                    const el = document.getElementById(action.target);
                    result = el ? { success: true, clicked: action.target } : { success: false, error: 'Element not found: ' + action.target };
                    if (el) el.click();
                    break;
                }
                case 'setValue': {
                    const el = document.getElementById(action.target);
                    if (el) {
                        if (el.type === 'checkbox') {
                            el.checked = action.value;
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        } else {
                            el.value = action.value;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        result = { success: true, set: action.target, value: action.value };
                    } else {
                        result = { success: false, error: 'Element not found: ' + action.target };
                    }
                    break;
                }
                case 'getValue': {
                    const el = document.getElementById(action.target);
                    result = el
                        ? { success: true, target: action.target, value: el.type === 'checkbox' ? el.checked : el.value, exists: true }
                        : { success: false, exists: false, error: 'Element not found: ' + action.target };
                    break;
                }
                case 'getText': {
                    const el = document.getElementById(action.target);
                    result = el
                        ? { success: true, target: action.target, text: el.innerText || el.textContent }
                        : { success: false, error: 'Element not found: ' + action.target };
                    break;
                }
                case 'getSnapshot':
                    result = {
                        success: true,
                        snapshot: {
                            scheduleEnabled: document.getElementById('scheduleEnabled')?.checked,
                            scheduleMode: document.getElementById('scheduleMode')?.value,
                            scheduleValue: document.getElementById('scheduleValue')?.value,
                            queueMode: document.getElementById('queueMode')?.value,
                            silenceTimeout: document.getElementById('silenceTimeout')?.value,
                            freqSlider: document.getElementById('freqSlider')?.value,
                            roiClickCount: document.getElementById('roiClickCount')?.innerText,
                            roiTimeSaved: document.getElementById('roiTimeSaved')?.innerText,
                            roiSessionCount: document.getElementById('roiSessionCount')?.innerText
                        }
                    };
                    break;
                case 'listElements': {
                    const els = document.querySelectorAll('button, input, select, textarea, [role=button]');
                    const list = [];
                    els.forEach(el => {
                        list.push({
                            id: el.id || null,
                            tag: el.tagName,
                            type: el.type || null,
                            value: el.value?.substring(0, 50) || null,
                            text: el.innerText?.substring(0, 50) || null
                        });
                    });
                    result = { success: true, elements: list, count: list.length };
                    break;
                }
                default:
                    result = { success: false, error: 'Unknown action type: ' + action.type };
            }
        } catch (err) {
            result = { success: false, error: err.message };
        }
        vscode.postMessage({ command: 'debugUIResult', result });
    }
});

// ============================================================
// INITIAL LOAD
// ============================================================
refreshStats();
vscode.postMessage({ command: 'getBannedCommands' });
vscode.postMessage({ command: 'getSchedule' });
vscode.postMessage({ command: 'getConversations' });
vscode.postMessage({ command: 'getPromptHistory' });
requestLogs();
updateModeVisibility();
