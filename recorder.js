// recorder.js - 录制用户操作并生成步骤
// 由 background.js 通过 chrome.scripting.executeScript 注入页面

(() => {
    if (window.__AUTOTASK_RECORDER_LOADED__) return;
    window.__AUTOTASK_RECORDER_LOADED__ = true;

    // ===== 选择器工具（内联）=====
    function getAccessibleName(el) {
        if (!el) return '';
        if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
        if (el.getAttribute('aria-labelledby')) {
            const labelEl = document.getElementById(el.getAttribute('aria-labelledby'));
            if (labelEl) return labelEl.textContent.trim();
        }
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
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        const isButtonLike = tag === 'button' || tag === 'a' || role === 'button' || role === 'link';
        if (isButtonLike) return (el.textContent || '').trim().replace(/\s+/g, ' ');
        return '';
    }

    function getRole(el) {
        if (!el) return null;
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        const map = {
            button: 'button', a: 'link',
            input: el.type === 'checkbox' ? 'checkbox' : (el.type === 'radio' ? 'radio' : 'textbox'),
            textarea: 'textbox', select: 'listbox', img: 'img',
            nav: 'navigation', main: 'main',
            h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
        };
        return map[tag] || null;
    }

    function buildCssSelector(el) {
        if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
        if (el.id) return `#${CSS.escape(el.id)}`;
        const parts = [];
        let node = el;
        while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
            let part = node.tagName.toLowerCase();
            if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
            const classes = Array.from(node.classList).filter(c =>
                c && !/(active|hover|focus|selected|disabled|loading|show|hide)/i.test(c)
            );
            if (classes.length > 0) part += '.' + classes.slice(0, 2).map(c => CSS.escape(c)).join('.');
            const parent = node.parentElement;
            if (parent) {
                const siblings = Array.from(parent.children).filter(s => s.tagName === node.tagName);
                if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
            }
            parts.unshift(part);
            node = node.parentElement;
        }
        return parts.length > 0 ? parts.join(' > ') : null;
    }

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
        if ((tag === 'input' || tag === 'textarea') && el.name) selector.attrName = el.name;
        return selector;
    }

    // ===== 录制状态 =====
    const state = {
        recording: true,
        steps: [],
        lastInputEl: null,
        lastInputTime: 0,
        lastInputValue: '',
    };

    // ===== UI 构建 =====
    function loadCSS() {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = chrome.runtime.getURL('recorder.css');
        document.head.appendChild(link);
    }

    function createUI() {
        loadCSS();
        const container = document.createElement('div');
        container.id = 'autotask-recorder';
        container.innerHTML = `
            <div class="ar-header">
                <span class="ar-dot"></span>
                <span class="ar-status">录制中...</span>
            </div>
            <div class="ar-body">
                <div class="ar-empty">开始操作页面，将自动记录点击和输入</div>
            </div>
            <div class="ar-footer">
                <button class="ar-btn-pause">暂停</button>
                <button class="ar-btn-wait">+等待</button>
                <button class="ar-btn-cancel">取消</button>
                <button class="ar-btn-save">保存</button>
            </div>
        `;
        document.documentElement.appendChild(container);

        // 拖拽
        const header = container.querySelector('.ar-header');
        let dragging = false, ox = 0, oy = 0;
        header.addEventListener('mousedown', (e) => {
            dragging = true;
            ox = e.clientX - container.offsetLeft;
            oy = e.clientY - container.offsetTop;
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            container.style.left = (e.clientX - ox) + 'px';
            container.style.top = (e.clientY - oy) + 'px';
            container.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { dragging = false; });

        // 暂停/继续
        container.querySelector('.ar-btn-pause').addEventListener('click', () => {
            state.recording = !state.recording;
            const btn = container.querySelector('.ar-btn-pause');
            const dot = container.querySelector('.ar-dot');
            const status = container.querySelector('.ar-status');
            if (state.recording) {
                btn.textContent = '暂停';
                dot.style.animation = 'ar-pulse 1.2s infinite';
                dot.style.background = '#f38ba8';
                status.textContent = '录制中...';
            } else {
                btn.textContent = '继续';
                dot.style.animation = 'none';
                dot.style.background = '#6c7086';
                status.textContent = '已暂停';
            }
        });

        // 添加等待步骤
        container.querySelector('.ar-btn-wait').addEventListener('click', () => {
            const ms = parseInt(prompt('等待时间（毫秒，默认2000）:', '2000')) || 2000;
            addStep({ type: 'wait', value: Math.min(ms, 60000) });
        });

        // 取消
        container.querySelector('.ar-btn-cancel').addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'recorder-cancel' });
        });

        // 保存
        container.querySelector('.ar-btn-save').addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'recorder-save', steps: state.steps });
        });

        renderSteps();
    }

    function renderSteps() {
        const body = document.querySelector('#autotask-recorder .ar-body');
        if (!body) return;
        if (state.steps.length === 0) {
            body.innerHTML = '<div class="ar-empty">开始操作页面，将自动记录点击和输入</div>';
            return;
        }
        body.innerHTML = state.steps.map((s, i) => {
            let desc = '';
            if (s.type === 'click') desc = s.selector.name || s.selector.text || s.selector.css || '元素';
            else if (s.type === 'fill') desc = `${s.selector.name || s.selector.css || '输入框'} = "${s.value}"`;
            else if (s.type === 'press') desc = `${s.key} 键`;
            else if (s.type === 'wait') desc = `${s.value}ms`;
            else if (s.type === 'navigate') desc = s.url;
            return `<div class="ar-step">
                <span class="ar-step-type ${s.type}">${s.type}</span>
                <span class="ar-step-desc">${escapeHtml(desc)}</span>
            </div>`;
        }).join('');
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function addStep(step) {
        step.waitAfter = 800;
        state.steps.push(step);
        renderSteps();
        console.log(`[AutoTask Recorder] +${step.type}`, step);
    }

    // ===== 事件捕获 =====

    // 点击：捕获明确的按钮/链接点击
    document.addEventListener('click', (e) => {
        if (!state.recording) return;
        if (e.isTrusted === false) return;
        // 忽略录制器自身 UI 的点击
        if (e.target.closest('#autotask-recorder')) return;

        const el = e.target.closest('button, a, [role="button"], [role="link"], input[type="checkbox"], input[type="radio"], input[type="submit"], .reply-markup-button, [class*="button"]');
        const target = el || e.target;
        const selector = buildSelector(target);
        if (!selector) return;
        addStep({ type: 'click', selector });
    }, true);

    // 输入：防抖合并连续输入
    document.addEventListener('input', (e) => {
        if (!state.recording) return;
        if (e.isTrusted === false) return;
        if (e.target.closest('#autotask-recorder')) return;

        const el = e.target;
        const tag = el.tagName.toLowerCase();
        const isInput = tag === 'input' || tag === 'textarea' || el.isContentEditable;
        if (!isInput) return;

        const value = tag === 'input' || tag === 'textarea' ? el.value : el.textContent;
        const now = Date.now();

        if (state.lastInputEl === el && (now - state.lastInputTime) < 1500) {
            // 合并：更新最后一条 fill 步骤的值
            const last = state.steps[state.steps.length - 1];
            if (last && last.type === 'fill' && last.selector === state.lastInputSelector) {
                last.value = value;
                state.lastInputTime = now;
                renderSteps();
                return;
            }
        }

        const selector = buildSelector(el);
        state.lastInputEl = el;
        state.lastInputSelector = selector;
        state.lastInputTime = now;
        addStep({ type: 'fill', selector, value });
    }, true);

    // 按键：捕获 Enter 等特殊键
    document.addEventListener('keydown', (e) => {
        if (!state.recording) return;
        if (e.isTrusted === false) return;
        if (e.target.closest('#autotask-recorder')) return;

        if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
            const el = e.target;
            const selector = buildSelector(el);
            // 如果上一个步骤已经是同一元素的 fill，合并为 press
            const last = state.steps[state.steps.length - 1];
            if (last && last.type === 'fill' && last.selector === selector) {
                addStep({ type: 'press', selector, key: e.key });
            } else if (selector) {
                addStep({ type: 'press', selector, key: e.key });
            }
        }
    }, true);

    // ===== 监听 background 消息 =====
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.action === 'recorder-stop') {
            const container = document.getElementById('autotask-recorder');
            if (container) container.remove();
            window.__AUTOTASK_RECORDER_LOADED__ = false;
        }
    });

    // ===== 启动 =====
    createUI();
    console.log('[AutoTask Recorder] 录制器已启动');
})();
