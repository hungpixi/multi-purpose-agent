// uiFixes.js
import { getDocuments, getAntigravityAgentPanelRoot } from './domUtils.js';

let _lastScrollTime = 0;
let _userPauseAutoScroll = false;
let _userResumeTimeout = null;

function _pauseAutoScroll() {
    _userPauseAutoScroll = true;
    clearTimeout(_userResumeTimeout);
    _userResumeTimeout = setTimeout(() => {
        _userPauseAutoScroll = false;
    }, 15000); // Pause for 15s after manual interaction
}

export function setupAutoScrollListeners() {
    if (!window.__autoScrollListenersAdded) {
        window.addEventListener('wheel', _pauseAutoScroll, { passive: true, capture: true });
        window.addEventListener('touchmove', _pauseAutoScroll, { passive: true, capture: true });
        window.addEventListener('keydown', (e) => {
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
                _pauseAutoScroll();
            }
        }, { passive: true, capture: true });
        window.__autoScrollListenersAdded = true;
    }
}

export function autoScrollChatToBottom(log) {
    try {
        if (_userPauseAutoScroll) return;

        const now = Date.now();
        if (now - _lastScrollTime < 500) return;
        _lastScrollTime = now;

        const panelRoot = getAntigravityAgentPanelRoot();
        const docs = getDocuments();
        
        for (const doc of docs) {
            let searchRoot = doc;
            
            // Nếu là document chính của IDE, CHỈ tìm trong Agent Panel (Khung Chat)
            // Tuyệt đối không quét global document để tránh cuộn sai Explorer/Editor!
            if (doc === document) {
                if (!panelRoot) continue;
                searchRoot = panelRoot;
            }

            // Chỉ tìm các container cuộn có class chứa dấu hiệu chat/scroll
            const scrollables = searchRoot.querySelectorAll('[class*="scroll"], [class*="chat"], [class*="conversation"], [class*="message"], [class*="output"], [class*="content"]');
            
            for (const el of scrollables) {
                // Bảo vệ: KHÔNG ĐƯỢC auto-scroll các thẻ input người dùng đang gõ
                if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.contentEditable === 'true') continue;

                const style = window.getComputedStyle(el);
                if (style.overflowY !== 'auto' && style.overflowY !== 'scroll' && style.overflow !== 'auto' && style.overflow !== 'scroll') continue;

                if (el.scrollHeight > el.clientHeight + 50) {
                    const isNotAtBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) > 100;
                    if (isNotAtBottom) {
                        el.scrollTop = el.scrollHeight;
                    }
                }
            }
            
            // Xử lý document.body hoặc scrollingElement nếu chính cái webview (iframe) cuộn
            if (doc !== document) {
                const rootScroll = doc.scrollingElement || doc.body;
                if (rootScroll && rootScroll.scrollHeight > rootScroll.clientHeight + 50) {
                    const isNotAtBottom = (rootScroll.scrollHeight - rootScroll.scrollTop - rootScroll.clientHeight) > 100;
                    if (isNotAtBottom) {
                        rootScroll.scrollTop = rootScroll.scrollHeight;
                    }
                }
            }
        }
    } catch (e) { }
}

export function autoExpandStepInputSections(log) {
    try {
        const panelRoot = getAntigravityAgentPanelRoot();
        const docs = getDocuments();
        
        for (const doc of docs) {
            let searchRoot = doc;
            
            // Nếu là document chính của IDE, CHỈ tìm trong Agent Panel (Khung Chat)
            if (doc === document) {
                if (!panelRoot) continue;
                searchRoot = panelRoot;
            }

            const allElements = searchRoot.querySelectorAll('[class*="collapsed"], [class*="collapsible"], [aria-expanded="false"], details:not([open]), [class*="step"], [class*="input-required"]');
            for (const el of allElements) {
                const text = (el.textContent || '').toLowerCase();
                if (text.includes('input') || text.includes('step') || text.includes('required') || text.includes('submit') || text.includes('enter')) {
                    if (el.tagName === 'DETAILS' && !el.open) {
                        el.open = true;
                        continue;
                    }
                    if (el.getAttribute('aria-expanded') === 'false') {
                        el.click();
                        continue;
                    }
                    const cls = (el.className || '').toLowerCase();
                    if (cls.includes('collapsed') && !cls.includes('expanded')) {
                        el.click();
                    }
                }
            }

            const toggles = searchRoot.querySelectorAll('[role="button"][aria-expanded="false"], button[aria-expanded="false"]');
            for (const toggle of toggles) {
                const text = (toggle.textContent || '').toLowerCase();
                const ariaLabel = (toggle.getAttribute('aria-label') || '').toLowerCase();
                const combined = text + ' ' + ariaLabel;
                if (combined.includes('input') || combined.includes('step') || combined.includes('required') || combined.includes('expand') || combined.includes('show')) {
                    toggle.click();
                }
            }

            const textareas = searchRoot.querySelectorAll('textarea, [contenteditable="true"]');
            for (const ta of textareas) {
                const rect = ta.getBoundingClientRect();
                if (rect.height < 5 || rect.width < 50) {
                    let parent = ta.parentElement;
                    let depth = 0;
                    while (parent && depth < 5) {
                        if (parent.getAttribute('aria-expanded') === 'false' || 
                            (parent.className || '').toLowerCase().includes('collapsed')) {
                            parent.click();
                            break;
                        }
                        parent = parent.parentElement;
                        depth++;
                    }
                }
            }
        }
    } catch (e) { }
}
