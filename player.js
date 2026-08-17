// player.js - 按步骤回放录制的操作
// 由 background.js 通过 chrome.scripting.executeScript 注入页面执行

(async function () {
    // 从 window.__AUTO_TASK_PLAY__ 获取任务步骤（由注入前赋值）
    const steps = window.__AUTO_TASK_PLAY__ && window.__AUTO_TASK_PLAY__.steps;
    const taskId = window.__AUTO_TASK_PLAY__ && window.__AUTO_TASK_PLAY__.taskId;
    if (!steps || !Array.isArray(steps)) {
        console.error('[AutoTask Player] No steps to play.');
        return;
    }

    // ===== 选择器工具（内联，避免依赖外部文件）=====
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

    function findBySelector(selector) {
        if (!selector) return null;
        // 1. role + name
        if (selector.role && selector.name) {
            const candidates = Array.from(document.querySelectorAll(
                `[role="${selector.role}"], ${selector.tag || '*'}`
            )).filter(el => {
                if (selector.tag && el.tagName.toLowerCase() !== selector.tag) return false;
                if (getRole(el) !== selector.role) return false;
                const n = getAccessibleName(el);
                return n === selector.name || n.includes(selector.name);
            });
            if (candidates.length > 0) return candidates[candidates.length - 1];
        }
        // 2. CSS
        if (selector.css) {
            try { const el = document.querySelector(selector.css); if (el) return el; } catch (e) { }
        }
        // 3. 文本
        if (selector.text) {
            const candidates = Array.from(document.querySelectorAll(
                selector.tag || 'button, a, div, span, [role="button"], [role="link"]'
            )).filter(el => {
                const t = (el.textContent || '').trim();
                return t === selector.text || t.includes(selector.text);
            });
            if (candidates.length > 0) return candidates[candidates.length - 1];
        }
        // 4. input name
        if (selector.attrName) {
            const el = document.querySelector(`[name="${CSS.escape(selector.attrName)}"]`);
            if (el) return el;
        }
        return null;
    }

    function isInteractive(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        if (style.pointerEvents === 'none') return false;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const topEl = document.elementFromPoint(x, y);
        if (topEl && topEl !== el && !el.contains(topEl) && !topEl.contains(el)) return false;
        return true;
    }

    function forceClick(el) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
        try {
            el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
        } catch (e) { /* 老浏览器降级 */ }
        el.click();
    }

    function waitForElement(selector, timeout = 15000) {
        return new Promise((resolve) => {
            const interval = 300;
            let elapsed = 0;
            const check = setInterval(() => {
                const el = findBySelector(selector);
                if (el && (!selector.requireInteractive || isInteractive(el))) {
                    clearInterval(check);
                    resolve(el);
                } else {
                    elapsed += interval;
                    if (elapsed >= timeout) { clearInterval(check); resolve(null); }
                }
            }, interval);
        });
    }

    // ===== 等待页面就绪 =====
    if (document.readyState !== 'complete') {
        await new Promise(r => window.addEventListener('load', r, { once: true }));
    }
    // 额外等待，确保 SPA 渲染
    await new Promise(r => setTimeout(r, 1500));

    // ===== 执行步骤 =====
    console.log(`[AutoTask Player] 开始回放任务 ${taskId}，共 ${steps.length} 步`);
    let success = true;

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        console.log(`[AutoTask Player] 步骤 ${i + 1}/${steps.length}: ${step.type}`, step);

        try {
            if (step.type === 'navigate') {
                if (location.href !== step.url) {
                    location.href = step.url;
                    // 页面会跳转，后续步骤在新页面继续（需任务分片，这里简单处理）
                    return { success: false, reason: 'navigation' };
                }
                await new Promise(r => setTimeout(r, 2000));
            }
            else if (step.type === 'wait') {
                const ms = Math.min(step.value || 1000, 60000);
                await new Promise(r => setTimeout(r, ms));
            }
            else if (step.type === 'click' || step.type === 'press') {
                const el = await waitForElement(step.selector, 15000);
                if (!el) {
                    console.warn(`[AutoTask Player] 步骤 ${i + 1} 找不到元素:`, step.selector);
                    success = false;
                    break;
                }
                forceClick(el);
                // press 类型的按键处理
                if (step.type === 'press' && step.key) {
                    const keyMap = { 'Enter': 13, 'Tab': 9, 'Escape': 27 };
                    const keyCode = keyMap[step.key] || 0;
                    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: step.key, keyCode }));
                    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: step.key, keyCode }));
                }
            }
            else if (step.type === 'fill') {
                const el = await waitForElement(step.selector, 15000);
                if (!el) {
                    console.warn(`[AutoTask Player] 步骤 ${i + 1} 找不到输入框:`, step.selector);
                    success = false;
                    break;
                }
                el.focus();
                el.click();
                // 清空并输入
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                    el.value = '';
                    el.value = step.value;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                    // contenteditable
                    document.execCommand('selectAll', false, null);
                    document.execCommand('insertText', false, step.value);
                }
            }
            else if (step.type === 'select') {
                const el = await waitForElement(step.selector, 15000);
                if (!el) { success = false; break; }
                el.value = step.value;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // 步骤间等待
            const waitAfter = step.waitAfter || 800;
            await new Promise(r => setTimeout(r, waitAfter));

        } catch (err) {
            console.error(`[AutoTask Player] 步骤 ${i + 1} 执行出错:`, err);
            success = false;
            break;
        }
    }

    console.log(`[AutoTask Player] 任务 ${taskId} 回放完成，结果: ${success}`);

    // 通知 background
    try {
        chrome.runtime.sendMessage({
            action: 'play-complete',
            taskId: taskId,
            success: success
        });
    } catch (e) {
        console.error('[AutoTask Player] 通知 background 失败:', e);
    }

    return { success };
})();
