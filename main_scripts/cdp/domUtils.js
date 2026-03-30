export const getAntigravityAgentPanelRoot = () => {
    try {
        const panel = document.getElementById('antigravity.agentPanel') || document.querySelector('#antigravity\\.agentPanel');
        return panel;
    } catch (e) {
        return null;
    }
};

export const getDocuments = (root = document) => {
    let docs = [root];

    // [Tối Ưu Hoá v2.0.1]: Chỉ focus quét iframe bên trong Panel của Agent, nếu không có mới tìm toàn cục
    if (root === document) {
        let panelRoot = getAntigravityAgentPanelRoot();
        if (panelRoot) {
            try {
                const iframes = panelRoot.querySelectorAll('iframe, frame');
                for (const iframe of iframes) {
                    try {
                        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                        if (iframeDoc) docs.push(...getDocuments(iframeDoc)); // Đệ quy trong iframe con
                    } catch (e) { }
                }
                return [...new Set(docs)]; // Trả về tài liệu gốc + nhánh bên trong panel
            } catch (e) { }
        }
    }

    // Default behavior (Fallback)
    try {
        const iframes = root.querySelectorAll('iframe, frame');
        for (const iframe of iframes) {
            try {
                const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                if (iframeDoc) docs.push(...getDocuments(iframeDoc));
            } catch (e) { }
        }
    } catch (e) { }
    return [...new Set(docs)];
};

export const queryAll = (selector) => {
    const results = [];
    getDocuments().forEach(doc => {
        try { results.push(...Array.from(doc.querySelectorAll(selector))); } catch (e) { }
    });
    return results;
};

export const isElementVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && rect.width > 0 && style.visibility !== 'hidden';
};

export const stripTimeSuffix = (text) => {
    return (text || '').trim().replace(/\s*\d+[smh]$/, '').trim();
};

export const getInputValue = (el) => {
    try {
        if (!el) return '';
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
        let text = el.innerText || el.textContent || '';
        return text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    } catch (e) {
        return '';
    }
};
