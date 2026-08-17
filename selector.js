// selector.js - 共享的选择器生成与解析工具
// 借鉴 Playwright 的定位策略：role+name 优先，CSS 和文本作为回退

// ===== 生成选择器 =====

// 获取元素的可访问名称（accessible name）
function getAccessibleName(el) {
    if (!el) return '';
    // aria-label / aria-labelledby 优先
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    if (el.getAttribute('aria-labelledby')) {
        const labelEl = document.getElementById(el.getAttribute('aria-labelledby'));
        if (labelEl) return labelEl.textContent.trim();
    }
    // input 的关联 label
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (el.id) {
            const label = document.querySelector(`label[for="${el.id}"]`);
            if (label) return label.textContent.trim();
        }
        const parentLabel = el.closest('label');
        if (parentLabel) return parentLabel.textContent.trim();
        if (el.placeholder) return el.placeholder.trim();
        if (el.getAttribute('title')) return el.getAttribute('title').trim();
    }
    // 按钮和链接用自身文本
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const isButtonLike = tag === 'button' || tag === 'a' || role === 'button' || role === 'link';
    if (isButtonLike) {
        return (el.textContent || '').trim().replace(/\s+/g, ' ');
    }
    return '';
}

// 获取元素的 role
function getRole(el) {
    if (!el) return null;
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const map = {
        button: 'button',
        a: 'link',
        input: el.type === 'checkbox' ? 'checkbox' : (el.type === 'radio' ? 'radio' : 'textbox'),
        textarea: 'textbox',
        select: 'listbox',
        img: 'img',
        nav: 'navigation',
        main: 'main',
        h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    };
    return map[tag] || null;
}

// 生成稳定的 CSS 选择器（带 id 优先）
function buildCssSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    if (el.id) return `#${CSS.escape(el.id)}`;

    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
            parts.unshift(`#${CSS.escape(node.id)}`);
            break;
        }
        // 添加 class（仅稳定的非动态 class）
        const classes = Array.from(node.classList).filter(c =>
            c && !/(active|hover|focus|selected|disabled|loading|show|hide)/i.test(c)
        );
        if (classes.length > 0) {
            part += '.' + classes.slice(0, 2).map(c => CSS.escape(c)).join('.');
        }
        // 添加 nth-of-type 以保证唯一
        const parent = node.parentElement;
        if (parent) {
            const siblings = Array.from(parent.children).filter(s => s.tagName === node.tagName);
            if (siblings.length > 1) {
                const index = siblings.indexOf(node) + 1;
                part += `:nth-of-type(${index})`;
            }
        }
        parts.unshift(part);
        node = node.parentElement;
    }
    return parts.length > 0 ? parts.join(' > ') : null;
}

// 为元素生成完整的选择器描述
function buildSelector(el) {
    if (!el) return null;
    const role = getRole(el);
    const name = getAccessibleName(el);
    const css = buildCssSelector(el);
    const text = (el.textContent || '').trim().slice(0, 50);
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type') || null;

    const selector = { tag, css };
    if (role) selector.role = role;
    if (name) selector.name = name;
    if (text && text.length <= 50) selector.text = text;
    if (type) selector.inputType = type;
    // 对于 input/textarea，记录 name 属性作为备用
    if ((tag === 'input' || tag === 'textarea') && el.name) {
        selector.attrName = el.name;
    }
    return selector;
}

// ===== 解析选择器（在页面中查找元素）=====

function findBySelector(selector) {
    if (!selector) return null;

    // 1. role + name 策略（Playwright getByRole 风格）
    if (selector.role && selector.name) {
        const candidates = Array.from(document.querySelectorAll(
            `[role="${selector.role}"], ${selector.tag || '*'}`
        )).filter(el => {
            if (selector.tag && el.tagName.toLowerCase() !== selector.tag) return false;
            const r = getRole(el);
            if (r !== selector.role) return false;
            const n = getAccessibleName(el);
            return n === selector.name || n.includes(selector.name);
        });
        if (candidates.length > 0) return candidates[candidates.length - 1];
    }

    // 2. CSS 选择器
    if (selector.css) {
        try {
            const el = document.querySelector(selector.css);
            if (el) return el;
        } catch (e) { /* 无效选择器，跳过 */ }
    }

    // 3. 文本匹配回退
    if (selector.text) {
        const candidates = Array.from(document.querySelectorAll(
            selector.tag || 'button, a, div, span, [role="button"], [role="link"]'
        )).filter(el => {
            const t = (el.textContent || '').trim();
            return t === selector.text || t.includes(selector.text);
        });
        if (candidates.length > 0) return candidates[candidates.length - 1];
    }

    // 4. input name 属性回退
    if (selector.attrName) {
        const el = document.querySelector(`[name="${CSS.escape(selector.attrName)}"]`);
        if (el) return el;
    }

    return null;
}
