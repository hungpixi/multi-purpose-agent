// index.js
import * as Analytics from './analytics.js';
import { performClick } from './clickHandler.js';
import { setupAutoScrollListeners, autoScrollChatToBottom, autoExpandStepInputSections } from './uiFixes.js';
import { sendPrompt, probePrompt } from './promptSender.js';
import { getAntigravityAgentPanelRoot, getInputValue, queryAll, isElementVisible, stripTimeSuffix } from './domUtils.js';

if (typeof window !== 'undefined') {
    const log = (msg, isSuccess = false) => {
        console.log(`[AutoAccept] ${msg}`);
    };

    Analytics.initialize(log);
    setupAutoScrollListeners();

    // Lifecycle variables cho thuật toán cũ
    let _isProcessing = false;

    const deduplicateNames = (names) => {
        const counts = {};
        return names.map(name => {
            if (counts[name] === undefined) {
                counts[name] = 1;
                return name;
            } else {
                counts[name]++;
                return `${name} (${counts[name]})`;
            }
        });
    };

    async function pollLoop(config) {
        const state = window.__autoAcceptState;
        const sid = state.sessionID;
        let tickCount = 0;

        while (state.isRunning && state.sessionID === sid) {
            try {
                tickCount++;

                // Throttling logic: Chạy các tác vụ UX mượt nhịp 1200ms
                if (tickCount % 4 === 0) {
                    autoScrollChatToBottom(log);
                    autoExpandStepInputSections(log);
                }
                
                // Step 3: Click accept/run/submit buttons (chạy liên tục siêu tốc 300ms - độ trễ zero)
                // Nhờ domUtils giới hạn Scope ở Agent Panel, việc query '[class*="button"]' không còn tốn kém
                await performClick(['button', '[class*="button"]', '[class*="anysphere"]', '[role="button"]'], log);
                
            } catch (err) {
                console.error('[AutoAccept] Error in loop:', err);
            }
            
            // Fast polling: 300ms for snappy response
            await new Promise(r => setTimeout(r, config.pollInterval || 300));
        }
    }

    window.__autoAcceptUpdateBannedCommands = function (bannedList) {
        const state = window.__autoAcceptState;
        state.bannedCommands = Array.isArray(bannedList) ? bannedList : [];
        log(`[Config] Updated banned commands list: ${state.bannedCommands.length} patterns`);
    };

    window.__autoAcceptGetStats = function () {
        const stats = Analytics.getStats();
        return {
            clicks: stats.clicksThisSession || 0,
            blocked: stats.blockedThisSession || 0,
            sessionStart: stats.sessionStartTime,
            fileEdits: stats.fileEditsThisSession || 0,
            terminalCommands: stats.terminalCommandsThisSession || 0,
            actionsWhileAway: stats.actionsWhileAway || 0
        };
    };

    window.__autoAcceptResetStats = function () {
        return Analytics.collectROI(log);
    };

    window.__autoAcceptGetSessionSummary = function () {
        return Analytics.getSessionSummary();
    };

    window.__autoAcceptGetAwayActions = function () {
        return Analytics.consumeAwayActions(log);
    };

    window.__autoAcceptSetFocusState = function (isFocused) {
        Analytics.setFocusState(isFocused, log);
    };

    window.__autoAcceptStart = function (config) {
        try {
            const ide = (config.ide || 'antigravity').toLowerCase();

            if (config.bannedCommands) {
                window.__autoAcceptUpdateBannedCommands(config.bannedCommands);
            }

            const state = window.__autoAcceptState;
            if (state.isRunning && state.currentMode === ide) {
                return;
            }

            if (state.isRunning) {
                window.__autoAcceptStop();
            }

            state.isRunning = true;
            state.currentMode = ide;
            state.sessionID++;

            if (!state.stats.sessionStartTime) {
                state.stats.sessionStartTime = Date.now();
            }

            log(`Agent Loaded (IDE: ${ide})`, true);

            // Khởi chạy vòng lặp polling siêu tốc 300ms (thuật toán cội nguồn phiên bản #2)
            setTimeout(() => {
                pollLoop(config);
            }, 0);

        } catch (e) {
            log(`ERROR in __autoAcceptStart: ${e.message}`);
        }
    };

    window.__autoAcceptStop = function () {
        const state = window.__autoAcceptState;
        if (state) {
            state.isRunning = false;
            state.currentMode = null;
        }
        log("Agent Stopped.");
    };

    window.__autoAcceptGetActiveTabName = function () {
        try {
            const tabs = queryAll('button.grow').filter(t => isElementVisible(t));
            if (!tabs || tabs.length === 0) return '';
            const active = tabs.find(t => t.getAttribute('aria-selected') === 'true')
                || tabs.find(t => t.getAttribute('aria-current') === 'true')
                || tabs.find(t => t.getAttribute('data-state') === 'active')
                || tabs.find(t => ((t.className || '').toLowerCase()).includes('active'))
                || tabs[0];
            const name = stripTimeSuffix(active?.textContent || '');
            return (name || '').trim();
        } catch (e) {
            return '';
        }
    };

    window.__autoAcceptProbePrompt = function () {
        return probePrompt();
    };

    window.__autoAcceptSendPrompt = async function (text) {
        return await sendPrompt(text, log);
    };

    window.__autoAcceptSendPromptToConversation = async (text, targetConversation) => {
        if (targetConversation && targetConversation !== 'current') {
            const tabs = queryAll('button.grow');
            const targetTab = Array.from(tabs).find(t => {
                const tabName = t.textContent.trim();
                return tabName.includes(targetConversation) || targetConversation.includes(tabName.split(' ')[0]);
            });

            if (targetTab) {
                targetTab.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                await new Promise(r => setTimeout(r, 500));
            }
        }
        return !!(await sendPrompt(text, log));
    };

    log("CDP Core Bundle Logic Loaded (Modularized)", true);
}
