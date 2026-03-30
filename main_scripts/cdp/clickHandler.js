// clickHandler.js
import { queryAll, isElementVisible } from './domUtils.js';
import { trackClick } from './analytics.js';
import { findNearbyCommandText, isCommandBanned } from './bannedCommands.js';

export function isAcceptButton(el, log) {
    let rawText = el.textContent || "";
    const text = rawText.replace(/[\u200B-\u200D\uFEFF]/g, '').trim().toLowerCase();
    if (text.length === 0 || text.length > 50) return false;
    // Patterns: [pattern, requireExact]
    // requireExact=true: button text phải BẰNG pattern (tránh false positive 'ok' match 'book')
    const patterns = [
        // Accept/Apply
        ['accept', false], ['accept all', false], ['apply', true], ['apply all', false],
        // Run
        ['run', false], ['run command', false], ['run code', false], ['run cell', false],
        ['run all', false], ['run selection', false], ['run and debug', false], ['run test', false],
        // Execute/Retry
        ['execute', true], ['resume', true], ['retry', true], ['try again', false],
        // Confirm/Proceed/Continue
        ['confirm', false], ['proceed', true], ['continue', true],
        // Allow - permission dialogs (khi AI xin quyền truy cập file ngoài workspace folder)
        ['allow', true], ['allow once', true], ['allow always', true],
        ['allow for this conversation', false], ['allow in this workspace', false],
        ['allow this workspace', false], ['allow access', false],
        ['grant access', false], ['grant', true],
        // Yes/OK dialogs
        ['yes', true], ['yes, proceed', false], ['ok', true], ['okay', true],
        // Save/Open/Submit
        ['save', true], ['open', true], ['submit', true],
    ];
    const rejects = ['skip', 'reject', 'cancel', 'close', 'refine', 'send to chat', 'submit to agent'];
    if (rejects.some(r => text.includes(r))) return false;
    if (!patterns.some(([p, exact]) => exact ? text === p : text.includes(p))) return false;

    const isCommandButton = text.includes('run command') || text.includes('execute') || text.includes('run');
    if (isCommandButton) {
        const nearbyText = findNearbyCommandText(el, log);
        if (isCommandBanned(nearbyText, el, log)) {
            log(`[BANNED] Skipping button: "${text}"`);
            return false;
        }
    }

    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && rect.width > 0 && style.pointerEvents !== 'none' && !el.disabled;
}

export function waitForDisappear(el, timeout = 500) {
    return new Promise(resolve => {
        const startTime = Date.now();
        const check = () => {
            if (!isElementVisible(el)) {
                resolve(true);
            } else if (Date.now() - startTime >= timeout) {
                resolve(false);
            } else {
                requestAnimationFrame(check);
            }
        };
        setTimeout(check, 50);
    });
}

export async function performClick(selectors, log) {
    const found = [];
    selectors.forEach(s => queryAll(s).forEach(el => found.push(el)));
    let clicked = 0;
    let verified = 0;
    const uniqueFound = [...new Set(found)];

    for (const el of uniqueFound) {
        // Prevent clicking already unmounted elements or elements hidden in previous loop iterations
        if (!el.isConnected || !isElementVisible(el)) continue;

        if (isAcceptButton(el, log)) {
            const buttonText = (el.textContent || "").trim();
            log(`Clicking: "${buttonText}"`);

            el.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
            clicked++;

            // Chờ nút biến mất (verify). Tối ưu từ 500ms xuống 200ms để tăng độ nhạy.
            // Có await ở đây để đảm bảo click dứt điểm trước khi qua element tiếp theo, chống layout thrashing.
            const disappeared = await waitForDisappear(el, 200);

            if (disappeared || !el.isConnected) {
                trackClick(buttonText, log);
                verified++;
            }
        }
    }
    return verified;
}
