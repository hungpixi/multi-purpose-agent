// bannedCommands.js
import { trackBlocked } from './analytics.js';

export function findNearbyCommandText(el, log) {
    const commandSelectors = ['pre', 'code', 'pre code'];
    let commandText = '';

    let container = el.parentElement;
    let depth = 0;
    const maxDepth = 10;

    while (container && depth < maxDepth) {
        let sibling = container.previousElementSibling;
        let siblingCount = 0;

        while (sibling && siblingCount < 5) {
            if (sibling.tagName === 'PRE' || sibling.tagName === 'CODE') {
                const text = sibling.textContent.trim();
                if (text.length > 0) {
                    commandText += ' ' + text;
                }
            }
            for (const selector of commandSelectors) {
                const codeElements = sibling.querySelectorAll(selector);
                for (const codeEl of codeElements) {
                    if (codeEl && codeEl.textContent) {
                        const text = codeEl.textContent.trim();
                        if (text.length > 0 && text.length < 5000) {
                            commandText += ' ' + text;
                        }
                    }
                }
            }
            sibling = sibling.previousElementSibling;
            siblingCount++;
        }
        if (commandText.length > 10) break;
        container = container.parentElement;
        depth++;
    }

    if (commandText.length === 0) {
        let btnSibling = el.previousElementSibling;
        let count = 0;
        while (btnSibling && count < 3) {
            for (const selector of commandSelectors) {
                const codeElements = btnSibling.querySelectorAll ? btnSibling.querySelectorAll(selector) : [];
                for (const codeEl of codeElements) {
                    if (codeEl && codeEl.textContent) {
                        commandText += ' ' + codeEl.textContent.trim();
                    }
                }
            }
            btnSibling = btnSibling.previousElementSibling;
            count++;
        }
    }

    if (el.getAttribute('aria-label')) commandText += ' ' + el.getAttribute('aria-label');
    if (el.getAttribute('title')) commandText += ' ' + el.getAttribute('title');

    return commandText.trim().toLowerCase();
}

export function isCommandBanned(commandText, element, log) {
    if (element && element.dataset.autoAcceptBlocked) return true;

    const state = window.__autoAcceptState;
    const bannedList = state.bannedCommands || [];

    if (bannedList.length === 0) return false;
    if (!commandText || commandText.length === 0) return false;

    const lowerText = commandText.toLowerCase();

    for (const banned of bannedList) {
        const pattern = banned.trim();
        if (!pattern || pattern.length === 0) continue;

        try {
            let isMatch = false;
            if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
                const lastSlash = pattern.lastIndexOf('/');
                const regexPattern = pattern.substring(1, lastSlash);
                const flags = pattern.substring(lastSlash + 1) || 'i';
                const regex = new RegExp(regexPattern, flags);
                if (regex.test(commandText)) {
                    log(`[BANNED] Regex blocked: /${regexPattern}/${flags}`);
                    isMatch = true;
                }
            } else {
                const lowerPattern = pattern.toLowerCase();
                if (lowerText.includes(lowerPattern)) {
                    log(`[BANNED] Pattern blocked: "${pattern}"`);
                    isMatch = true;
                }
            }

            if (isMatch) {
                trackBlocked(log);
                if (element) element.dataset.autoAcceptBlocked = 'true';
                return true;
            }
        } catch (e) {
            if (lowerText.includes(pattern.toLowerCase())) {
                trackBlocked(log);
                if (element) element.dataset.autoAcceptBlocked = 'true';
                return true;
            }
        }
    }
    return false;
}
