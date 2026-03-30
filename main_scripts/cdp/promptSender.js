// promptSender.js
import { getDocuments, queryAll, isElementVisible, getInputValue, getAntigravityAgentPanelRoot } from './domUtils.js';

function getInputHint(el) {
    try {
        if (!el) return '';
        const attrs = [
            el.getAttribute('placeholder'),
            el.getAttribute('aria-label'),
            el.getAttribute('data-placeholder'),
            el.getAttribute('title')
        ].filter(Boolean);
        return attrs.join(' ').trim();
    } catch (e) {
        return '';
    }
}

function isProbablyIMEOverlay(className) {
    const c = (className || '').toLowerCase();
    return /\bime\b/.test(c) || c.includes('ime-text-area');
}

function queryAllWithin(root, selector) {
    try {
        const results = [];
        getDocuments(root).forEach(doc => {
            try { results.push(...Array.from(doc.querySelectorAll(selector))); } catch (e) { }
        });
        return results;
    } catch (e) {
        try { return Array.from((root || document).querySelectorAll(selector)); } catch (e2) { }
    }
    return [];
}

export function findAntigravityChatInputContentEditable(root = document) {
    try {
        const editables = queryAllWithin(root, '[contenteditable]');
        let candidate = null;

        for (const el of editables) {
            const attr = (el.getAttribute && el.getAttribute('contenteditable')) || '';
            if (String(attr).toLowerCase() === 'false') continue;

            const rect = el.getBoundingClientRect();
            const className = el.className || '';
            const c = String(className).toLowerCase();
            const doc = el.ownerDocument || document;
            const win = doc.defaultView || window;

            try {
                const style = win.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
            } catch (e) { }

            if (isProbablyIMEOverlay(className)) continue;
            if (rect.width < 100 || rect.height < 20) continue;

            if (c.includes('cursor-text') || c.includes('overflow')) return el;

            if (!candidate && rect.width > 200) candidate = el;
        }

        return candidate;
    } catch (e) {
        return null;
    }
}

function scorePromptInputCandidate(el) {
    try {
        const rect = el.getBoundingClientRect();
        const visible = isElementVisible(el);
        if (!visible) return -1;
        if (rect.width < 120 || rect.height < 18) return -1;

        const className = el.className || '';
        if (isProbablyIMEOverlay(className)) return -1;

        const hint = (getInputHint(el) + ' ' + className).toLowerCase();
        const bottomDistance = Math.abs(window.innerHeight - rect.bottom);

        let score = 0;
        score += Math.min(rect.width, 1200) / 8;
        score += Math.min(rect.height, 200) / 4;
        score += Math.max(0, 400 - bottomDistance) / 4;

        if (el.contentEditable === 'true') score += 8;
        if (hint.includes('ask anything')) score += 80;
        if (hint.includes('ask') || hint.includes('message') || hint.includes('prompt') || hint.includes('chat')) score += 35;
        if (hint.includes('cursor') || hint.includes('composer')) score += 20;

        try {
            if (el.closest) {
                if (el.closest('#antigravity\\.agentPanel')) score += 25;
                if (el.closest('[class*="chat" i]')) score += 12;
                if (el.closest('[data-testid*="chat" i]')) score += 12;
            }
        } catch (e) { }

        return score;
    } catch (e) {
        return -1;
    }
}

export function findBestPromptInput() {
    const candidates = [];
    const selector = 'textarea, input[type="text"], [contenteditable="true"], [role="textbox"], .ProseMirror';
    const els = queryAll(selector);
    for (const el of els) {
        const score = scorePromptInputCandidate(el);
        if (score >= 0) {
            candidates.push({ el, score });
        }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length > 0 ? candidates[0].el : null;
}

function isClickable(el) {
    try {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return false;
        const win = el.ownerDocument?.defaultView || window;
        const style = win.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        if ('disabled' in el && el.disabled) return false;
        return true;
    } catch (e) {
        return false;
    }
}

function findSendButtonNearInput(inputBox) {
    const doc = inputBox?.ownerDocument || document;
    const roots = [];
    try {
        const form = inputBox?.closest ? inputBox.closest('form') : null;
        if (form) roots.push(form);
    } catch (e) { }

    try {
        if (inputBox?.parentElement) roots.push(inputBox.parentElement);
    } catch (e) { }

    roots.push(doc);

    const selectors = [
        'button[type="submit"]',
        'button[aria-label*="Send" i]',
        'button[title*="Send" i]',
        'button[data-testid*="send" i]',
        'button[data-testid*="submit" i]',
        '[role="button"][aria-label*="Send" i]',
        '[role="button"][title*="Send" i]'
    ];

    for (const root of roots) {
        for (const sel of selectors) {
            const btn = root.querySelector(sel);
            if (isClickable(btn)) return btn;
        }

        const candidates = root.querySelectorAll('button,[role="button"]');
        for (const btn of candidates) {
            const label = ((btn.getAttribute('aria-label') || '') + ' ' + (btn.getAttribute('title') || '') + ' ' + (btn.textContent || '')).trim().toLowerCase();
            if (!label) continue;
            if (label === 'send' || label.includes(' send') || label.includes('send ') || label.includes('send') || label.includes('submit')) {
                if (isClickable(btn)) return btn;
            }
        }
    }

    try {
        const inputRect = inputBox.getBoundingClientRect();
        const searchRoot = roots[0] && roots[0] !== document ? roots[0] : (inputBox.parentElement || document);
        const near = searchRoot.querySelectorAll('button,[role="button"],div[tabindex],span[tabindex]');
        let best = null;
        let bestScore = -Infinity;

        for (const el of near) {
            if (!isClickable(el)) continue;
            if (el === inputBox) continue;
            if (el.contains && el.contains(inputBox)) continue;

            const r = el.getBoundingClientRect();
            const dx = r.left - inputRect.right;
            const dy = Math.abs(((r.top + r.bottom) / 2) - ((inputRect.top + inputRect.bottom) / 2));

            if (dx < -20 || dx > 180) continue;
            if (dy > 70) continue;

            const hasSvg = !!el.querySelector('svg');
            let score = 0;
            score += hasSvg ? 30 : 0;
            score += (180 - dx);
            score += (70 - dy);
            score += Math.min(60, r.width + r.height);

            if (score > bestScore) {
                bestScore = score;
                best = el;
            }
        }
        if (best) return best;
    } catch (e) { }
    return null;
}

export function probePrompt() {
    try {
        const panel = getAntigravityAgentPanelRoot();
        const root = panel || document;
        let inputBox = findAntigravityChatInputContentEditable(root);
        if (!inputBox) {
            inputBox = findBestPromptInput();
        }
        if (!inputBox) {
            return { hasInput: false, score: 0, hasAgentPanel: !!panel };
        }
        const rect = inputBox.getBoundingClientRect();
        const className = String(inputBox.className || '');
        const c = className.toLowerCase();

        let score = 0;
        if (panel) score += 1000;
        score += 200;
        if (c.includes('cursor-text') || c.includes('overflow')) score += 200;
        score += Math.min(rect.width, 1200) / 10;
        score += Math.min(rect.height, 300) / 10;

        const sendBtn = findSendButtonNearInput(inputBox);
        return {
            hasInput: true,
            score,
            hasAgentPanel: !!panel,
            inIframe: (inputBox.ownerDocument && inputBox.ownerDocument !== document),
            tagName: inputBox.tagName,
            hint: getInputHint(inputBox),
            className: className.substring(0, 120),
            rect: { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) },
            hasSendButton: !!sendBtn
        };
    } catch (e) {
        return { hasInput: false, score: 0, error: e?.message || String(e) };
    }
}

function setPromptText(inputBox, text) {
    try {
        const doc = inputBox.ownerDocument || document;
        const win = doc.defaultView || window;
        inputBox.focus();

        if (inputBox.tagName === 'TEXTAREA' || inputBox.tagName === 'INPUT') {
            const proto = inputBox.tagName === 'TEXTAREA'
                ? win.HTMLTextAreaElement.prototype
                : win.HTMLInputElement.prototype;
            const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (nativeSetter) {
                nativeSetter.call(inputBox, text);
            } else {
                inputBox.value = text;
            }
            try { inputBox.dispatchEvent(new win.Event('input', { bubbles: true })); } catch (e) { inputBox.dispatchEvent(new Event('input', { bubbles: true })); }
            return true;
        }

        if (inputBox.contentEditable === 'true' || inputBox.classList?.contains('ProseMirror') || inputBox.getAttribute?.('role') === 'textbox') {
            try {
                doc.execCommand('selectAll', false, null);
                const ok = doc.execCommand('insertText', false, text);
                if (!ok) {
                    inputBox.innerText = text;
                }
            } catch (e) {
                inputBox.innerText = text;
            }
            try { inputBox.dispatchEvent(new win.Event('input', { bubbles: true })); } catch (e) { inputBox.dispatchEvent(new Event('input', { bubbles: true })); }
            return true;
        }

        inputBox.innerText = text;
        try { inputBox.dispatchEvent(new win.Event('input', { bubbles: true })); } catch (e) { inputBox.dispatchEvent(new Event('input', { bubbles: true })); }
        return true;
    } catch (e) {
        return false;
    }
}

export async function sendPrompt(text, log) {
    try {
        log(`[Prompt] Request to send: "${String(text).substring(0, 50)}..."`);
        const panel = getAntigravityAgentPanelRoot();
        const root = panel || document;
        let inputBox = findAntigravityChatInputContentEditable(root);

        const isDocFirst = !!inputBox;
        if (!inputBox) inputBox = findBestPromptInput();
        if (!inputBox) {
            log('[Prompt] ERROR: No suitable input found!');
            return false;
        }

        const doc = inputBox.ownerDocument || document;
        const win = doc.defaultView || window;
        
        inputBox.focus();
        try {
            if (doc.execCommand) {
                doc.execCommand('selectAll', false, null);
                const ok = doc.execCommand('insertText', false, String(text));
                if (!ok) inputBox.innerText = String(text);
            } else {
                inputBox.innerText = String(text);
            }
        } catch (e) {
            inputBox.innerText = String(text);
        }
        try { inputBox.dispatchEvent(new win.Event('input', { bubbles: true })); } catch (e) { inputBox.dispatchEvent(new Event('input', { bubbles: true })); }

        await new Promise(r => setTimeout(r, 300));

        const dispatchEnter = (opts = {}) => {
            const params = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, ...opts };
            try {
                inputBox.dispatchEvent(new win.KeyboardEvent('keydown', params));
                inputBox.dispatchEvent(new win.KeyboardEvent('keypress', params));
                inputBox.dispatchEvent(new win.KeyboardEvent('keyup', params));
            } catch (e) {
                inputBox.dispatchEvent(new KeyboardEvent('keydown', params));
                inputBox.dispatchEvent(new KeyboardEvent('keypress', params));
                inputBox.dispatchEvent(new KeyboardEvent('keyup', params));
            }
        };

        inputBox.focus();
        dispatchEnter();

        const waitForClear = async (timeoutMs) => {
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                await new Promise(r => setTimeout(r, 100));
                const current = getInputValue(inputBox);
                if (!current) return true;
            }
            return false;
        };

        if (await waitForClear(3500)) {
            log('[Prompt] Sent via Enter (composer cleared)');
            return true;
        }

        log('[Prompt] Enter did not clear composer; trying Ctrl+Enter and send-button fallback...');
        setPromptText(inputBox, text);
        await new Promise(r => setTimeout(r, 150));
        dispatchEnter({ ctrlKey: true });
        if (await waitForClear(3500)) {
            log('[Prompt] Sent via Ctrl+Enter (composer cleared)');
            return true;
        }

        const sendBtn = findSendButtonNearInput(inputBox);
        if (sendBtn) {
            try { sendBtn.click(); } catch (e) { }
            if (await waitForClear(3500)) {
                log('[Prompt] Sent via Send button (composer cleared)');
                return true;
            }
        }

        log('[Prompt] ERROR: Prompt did not appear to send (composer not cleared)');
        return false;
    } catch (e) {
        log(`[Prompt] ERROR: ${e?.message || String(e)}`);
        return false;
    }
}
