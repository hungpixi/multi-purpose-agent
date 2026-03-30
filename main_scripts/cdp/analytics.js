// analytics.js
const TERMINAL_KEYWORDS = ['run', 'execute', 'command', 'terminal'];
const SECONDS_PER_CLICK = 5;
const TIME_VARIANCE = 0.2;

export const ActionType = {
    FILE_EDIT: 'file_edit',
    TERMINAL_COMMAND: 'terminal_command'
};

function createDefaultStats() {
    return {
        clicksThisSession: 0,
        blockedThisSession: 0,
        sessionStartTime: null,
        fileEditsThisSession: 0,
        terminalCommandsThisSession: 0,
        actionsWhileAway: 0,
        isWindowFocused: true,
        lastConversationUrl: null,
        lastConversationStats: null
    };
}

export function getStats() {
    return window.__autoAcceptState?.stats || createDefaultStats();
}

function getStatsMutable() {
    return window.__autoAcceptState.stats;
}

export function categorizeClick(buttonText) {
    const text = (buttonText || '').toLowerCase();
    for (const keyword of TERMINAL_KEYWORDS) {
        if (text.includes(keyword)) return ActionType.TERMINAL_COMMAND;
    }
    return ActionType.FILE_EDIT;
}

export function trackClick(buttonText, log) {
    const stats = getStatsMutable();
    stats.clicksThisSession++;
    log(`[Stats] Click tracked. Total: ${stats.clicksThisSession}`);

    const category = categorizeClick(buttonText);
    if (category === ActionType.TERMINAL_COMMAND) {
        stats.terminalCommandsThisSession++;
        log(`[Stats] Terminal command. Total: ${stats.terminalCommandsThisSession}`);
    } else {
        stats.fileEditsThisSession++;
        log(`[Stats] File edit. Total: ${stats.fileEditsThisSession}`);
    }

    let isAway = false;
    if (!stats.isWindowFocused) {
        stats.actionsWhileAway++;
        isAway = true;
        log(`[Stats] Away action. Total away: ${stats.actionsWhileAway}`);
    }

    return { category, isAway, totalClicks: stats.clicksThisSession };
}

export function trackBlocked(log) {
    const stats = getStatsMutable();
    stats.blockedThisSession++;
    log(`[Stats] Blocked. Total: ${stats.blockedThisSession}`);
}

export function collectROI(log) {
    const stats = getStatsMutable();
    const collected = {
        clicks: stats.clicksThisSession || 0,
        blocked: stats.blockedThisSession || 0,
        sessionStart: stats.sessionStartTime
    };
    log(`[ROI] Collected: ${collected.clicks} clicks, ${collected.blocked} blocked`);
    stats.clicksThisSession = 0;
    stats.blockedThisSession = 0;
    stats.sessionStartTime = Date.now();
    return collected;
}

export function getSessionSummary() {
    const stats = getStats();
    const clicks = stats.clicksThisSession || 0;
    const baseSecs = clicks * SECONDS_PER_CLICK;
    const minMins = Math.max(1, Math.floor((baseSecs * (1 - TIME_VARIANCE)) / 60));
    const maxMins = Math.ceil((baseSecs * (1 + TIME_VARIANCE)) / 60);

    return {
        clicks,
        fileEdits: stats.fileEditsThisSession || 0,
        terminalCommands: stats.terminalCommandsThisSession || 0,
        blocked: stats.blockedThisSession || 0,
        estimatedTimeSaved: clicks > 0 ? `${minMins}–${maxMins} minutes` : null
    };
}

export function consumeAwayActions(log) {
    const stats = getStatsMutable();
    const count = stats.actionsWhileAway || 0;
    log(`[Away] Consuming away actions: ${count}`);
    stats.actionsWhileAway = 0;
    return count;
}

export function isUserAway() {
    return !getStats().isWindowFocused;
}

function initializeFocusState(log) {
    const state = window.__autoAcceptState;
    if (state && state.stats) {
        state.stats.isWindowFocused = true;
        log('[Focus] Initialized (awaiting extension sync)');
    }
}

export function initialize(log) {
    if (!window.__autoAcceptState) {
        window.__autoAcceptState = {
            isRunning: false,
            tabNames: [],
            sessionID: 0,
            currentMode: null,
            bannedCommands: [],
            stats: createDefaultStats()
        };
        log('[Analytics] State initialized');
    } else if (!window.__autoAcceptState.stats) {
        window.__autoAcceptState.stats = createDefaultStats();
        log('[Analytics] Stats added to existing state');
    } else {
        const s = window.__autoAcceptState.stats;
        if (s.actionsWhileAway === undefined) s.actionsWhileAway = 0;
        if (s.isWindowFocused === undefined) s.isWindowFocused = true;
        if (s.fileEditsThisSession === undefined) s.fileEditsThisSession = 0;
        if (s.terminalCommandsThisSession === undefined) s.terminalCommandsThisSession = 0;
    }

    initializeFocusState(log);

    if (!window.__autoAcceptState.stats.sessionStartTime) {
        window.__autoAcceptState.stats.sessionStartTime = Date.now();
    }

    log('[Analytics] Initialized');
}

export function setFocusState(isFocused, log) {
    const state = window.__autoAcceptState;
    if (!state || !state.stats) return;
    const wasAway = !state.stats.isWindowFocused;
    state.stats.isWindowFocused = isFocused;
    if (log) {
        log(`[Focus] Extension sync: focused=${isFocused}, wasAway=${wasAway}`);
    }
}
