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

    // accept: 可选过滤函数（Telegram：只接受最新消息里的元素，避免点到历史菜单）
    function findBySelector(selector, accept) {
        if (!selector) return null;
        const pick = (list) => {
            if (accept) list = list.filter(accept);
            return list.length > 0 ? list[list.length - 1] : null;
        };
        // 兼容旧录制：菜单内部图标的 nth-of-type 路径会随输入区布局变化。
        // 点击监听在外层按钮上，不依赖内部动画图标或兄弟节点序号。
        if (isTelegramCommandsSelector(selector)) {
            const candidates = Array.from(document.querySelectorAll(
                '#column-center .chat-input-main .new-message-bot-commands'
            )).filter(isInteractive);
            // 不猜测多个聊天容器中哪一个是目标，等待切换/动画结束。
            return candidates.length === 1 ? candidates[0] : null;
        }
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
            const hit = pick(candidates);
            if (hit) return hit;
        }
        // 2. CSS
        if (selector.css) {
            try {
                const el = accept
                    ? pick(Array.from(document.querySelectorAll(selector.css)))
                    : document.querySelector(selector.css);
                if (el) return el;
            } catch (e) { }
        }
        // 3. 文本
        if (selector.text) {
            const candidates = Array.from(document.querySelectorAll(
                selector.tag || 'button, a, div, span, [role="button"], [role="link"]'
            )).filter(el => {
                const t = (el.textContent || '').trim();
                return t === selector.text || t.includes(selector.text);
            });
            const hit = pick(candidates);
            if (hit) return hit;
        }
        // 4. input name
        if (selector.attrName) {
            const el = document.querySelector(`[name="${CSS.escape(selector.attrName)}"]`);
            if (el) return el;
        }
        return null;
    }

    function isTelegramCommandsSelector(selector) {
        return new URL(location.href).hostname === 'web.telegram.org' &&
            (selector.kind === 'telegram-bot-commands' ||
                /\.new-message-bot-commands(?=[\s.:#>\[]|$)/.test(selector.css || ''));
    }

    function isInteractive(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        if (style.pointerEvents === 'none') return false;
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const topEl = document.elementFromPoint(x, y);
        if (!topEl) return false;
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

    // Telegram：最新一条消息的 mid（用于判断后续出现的是否为"新"消息）
    function getBubbles() {
        return Array.from(document.querySelectorAll('#column-center .bubble[data-mid]'));
    }
    function lastBubbleMid() {
        const bs = getBubbles();
        return bs.length ? Number(bs[bs.length - 1].dataset.mid) || 0 : 0;
    }
    // 只接受位于"最新一条消息"且比触发前更新的按钮，避免点到历史菜单。
    function makeNewestBubbleFilter(minMid) {
        return (el) => {
            const b = el.closest('.bubble[data-mid]');
            // 不在消息气泡里的元素（如命令弹窗里的 /start）不受限制；
            // 但包含气泡的外层容器不算（文本匹配会命中它们）。
            if (!b) return !el.querySelector('.bubble');
            const bs = getBubbles();
            return bs[bs.length - 1] === b && (Number(b.dataset.mid) || 0) > minMid;
        };
    }

    async function waitForNewElement(selector, minMid, timeout = 60000) {
        if (minMid == null) return waitForElement(selector, timeout);
        const fresh = await waitForElement(selector, Math.min(30000, timeout), makeNewestBubbleFilter(minMid));
        if (fresh) {
            // 等新菜单布局稳定再点击
            await new Promise(r => setTimeout(r, 500));
            return fresh;
        }
        if (window.__AUTO_TASK_CANCELLED__) return null;
        console.warn('[AutoTask Player] 未等到新菜单，退化为使用已有元素');
        return waitForElement(selector, timeout);
    }

    function waitForElement(selector, timeout = 60000, accept) {
        return new Promise((resolve) => {
            const deadline = Date.now() + timeout;
            let timer;
            let finished = false;
            const observer = new MutationObserver(check);
            function finish(el) {
                finished = true;
                clearTimeout(timer);
                observer.disconnect();
                resolve(el);
            }
            function check() {
                if (finished) return;
                clearTimeout(timer);
                if (window.__AUTO_TASK_CANCELLED__ || Date.now() >= deadline) {
                    finish(null);
                    return;
                }
                const el = findBySelector(selector, accept);
                if (el && (!selector.requireInteractive || isInteractive(el))) {
                    finish(el);
                } else {
                    timer = setTimeout(check, Math.min(300, deadline - Date.now()));
                }
            }
            // DOM 更新时立即检查，轮询补充检查样式变化；按真实时间计算超时。
            observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
            check();
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
    let staleSnapshot = null;

    for (let i = 0; i < steps.length; i++) {
        if (window.__AUTO_TASK_CANCELLED__) { success = false; break; }
        const step = steps[i];
        console.log(`[AutoTask Player] 步骤 ${i + 1}/${steps.length}: ${step.type}`, step);

        // Telegram：当前步骤会触发新消息（如发送 /start），下一步点击必须等新菜单出现，
        // 否则会点到聊天历史里旧菜单的同名按钮。在本步骤执行前记录已有按钮。
        // wait 步骤不触发新消息，沿用之前的快照（菜单可能在 wait 期间出现）。
        // 先取出上一步为本步骤准备的快照，再为下一步记录新快照（顺序不能反）。
        const stale = staleSnapshot;
        staleSnapshot = step.type === 'wait' ? stale : null;
        const nextStep = steps[i + 1];
        if (location.hostname === 'web.telegram.org' && nextStep && nextStep.type === 'click' &&
            step.type !== 'navigate' && step.type !== 'wait' &&
            !isTelegramCommandsSelector(nextStep.selector || {})) {
            staleSnapshot = lastBubbleMid();
        }

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
                const minMid = step.type === 'click' ? stale : null;
                if (minMid != null) console.log(`[AutoTask Player] 步骤 ${i + 1} 等待比 mid=${minMid} 更新的消息中的按钮`);
                const el = await waitForNewElement(step.selector, minMid);
                const bubble = el && el.closest('.bubble[data-mid]');
                if (bubble) console.log(`[AutoTask Player] 步骤 ${i + 1} 点击消息 mid=${bubble.dataset.mid} 中的按钮`);
                if (!el) {
                    console.warn(`[AutoTask Player] 步骤 ${i + 1} 找不到元素（等待上限 60 秒）: ${JSON.stringify(step.selector)}; url=${location.href}; visibility=${document.visibilityState}`);
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
                const el = await waitForElement(step.selector);
                if (!el) {
                    console.warn(`[AutoTask Player] 步骤 ${i + 1} 找不到输入框（等待上限 60 秒）: ${JSON.stringify(step.selector)}; url=${location.href}; visibility=${document.visibilityState}`);
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
                const el = await waitForElement(step.selector);
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
