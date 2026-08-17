// popup.js

document.addEventListener('DOMContentLoaded', () => {
    const taskList = document.getElementById('task-list');
    const newName = document.getElementById('new-name');
    const newUrl = document.getElementById('new-url');
    const newTime = document.getElementById('new-time');
    const btnRecord = document.getElementById('btn-record');
    const btnReloadAlarms = document.getElementById('btn-reload-alarms');
    const btnRunAll = document.getElementById('btn-run-all');
    const statusDiv = document.getElementById('status');

    let tasks = [];
    let taskStatuses = {};

    loadTasks();

    function loadTasks() {
        chrome.storage.sync.get(['tasks', 'taskStatuses'], (result) => {
            tasks = result.tasks || [];
            taskStatuses = result.taskStatuses || {};
            renderTasks();
        });
    }

    function saveTasks() {
        chrome.storage.sync.set({ tasks }, () => {
            showStatus('已保存');
            chrome.runtime.sendMessage({ action: "update-alarms" });
        });
    }

    function getTodayDateString() {
        return new Date().toISOString().split('T')[0];
    }

    function getTaskDisplayStatus(taskId) {
        const statusInfo = taskStatuses[taskId];
        if (!statusInfo) return { status: 'pending', text: '未执行', lastTime: '' };
        const lastTime = statusInfo.lastExecuteTime || '';
        if (statusInfo.lastExecuteDate !== getTodayDateString()) {
            return { status: 'pending', text: '未执行', lastTime: lastTime };
        }
        return statusInfo.status === 'success'
            ? { status: 'success', text: '成功', lastTime: lastTime }
            : { status: 'failed', text: '失败', lastTime: lastTime };
    }

    function summarizeSteps(steps) {
        if (!steps || steps.length === 0) return '无步骤';
        const count = steps.length;
        const types = {};
        steps.forEach(s => { types[s.type] = (types[s.type] || 0) + 1; });
        const parts = Object.entries(types).map(([t, c]) => `${t}×${c}`);
        return `${count} 步: ${parts.join(', ')}`;
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    function describeStep(step) {
        const s = step.selector;
        switch (step.type) {
            case 'click':
            case 'press':
                return (s && (s.name || s.text || s.css)) || '元素';
            case 'fill':
                return `${(s && (s.name || s.css)) || '输入框'} = "${step.value || ''}"`;
            case 'select':
                return `${(s && (s.name || s.css)) || '下拉框'} = "${step.value || ''}"`;
            case 'wait':
                return `${step.value || 0}ms`;
            case 'navigate':
                return step.url || '';
            default:
                return JSON.stringify(step);
        }
    }

    function renderTasks() {
        taskList.innerHTML = '';
        if (tasks.length === 0) {
            taskList.innerHTML = '<div style="text-align:center; color:#999; padding:10px;">暂无任务，请在下方录制</div>';
            return;
        }

        tasks.forEach((task, index) => {
            const displayStatus = getTaskDisplayStatus(task.id);
            const div = document.createElement('div');
            div.className = 'task-item';
            div.innerHTML = `
                <div class="task-header">
                    <span class="task-status status-${displayStatus.status}">${displayStatus.text}</span>
                    <div>
                        <button class="run-btn" data-id="${task.id}">执行</button>
                        <button class="edit-btn" data-index="${index}">编辑</button>
                        <button class="delete-btn" data-index="${index}">删除</button>
                    </div>
                </div>
                <div class="task-info"><strong>名称:</strong> ${escapeHtml(task.name || task.url)}</div>
                <div class="task-info"><strong>时间:</strong> ${escapeHtml(task.time)}</div>
                <div class="task-info"><strong>网址:</strong> ${escapeHtml(task.url)}</div>
                <div class="task-steps">${escapeHtml(summarizeSteps(task.steps))}</div>
                ${displayStatus.lastTime ? `<div class="task-last-time">上次执行: ${escapeHtml(displayStatus.lastTime)}</div>` : ''}
            `;
            taskList.appendChild(div);
        });

        document.querySelectorAll('.run-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const taskId = e.target.dataset.id;
                chrome.runtime.sendMessage({ action: "trigger-one", taskId });
                showStatus(`任务已触发`);
            });
        });

        document.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.dataset.index);
                openEditPanel(idx);
            });
        });

        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.dataset.index);
                const deletedTaskId = tasks[idx].id;
                tasks.splice(idx, 1);
                if (taskStatuses[deletedTaskId]) {
                    delete taskStatuses[deletedTaskId];
                    chrome.storage.sync.set({ taskStatuses });
                }
                saveTasks();
                renderTasks();
            });
        });
    }

    // ===== 编辑面板 =====
    function openEditPanel(taskIndex) {
        const task = tasks[taskIndex];
        if (!task) return;

        const itemEl = taskList.children[taskIndex];
        // 若已展开，则收起
        const existing = itemEl.querySelector('.edit-panel');
        if (existing) { existing.remove(); return; }

        const panel = document.createElement('div');
        panel.className = 'edit-panel';

        const steps = (task.steps && task.steps.length > 0)
            ? task.steps
            : [];

        panel.innerHTML = `
            <div class="edit-step-row" style="margin-bottom:8px;">
                <label>任务名称:</label>
                <input type="text" class="inp-name" value="${escapeHtml(task.name || task.url || '')}">
            </div>
            <div class="edit-step-row" style="margin-bottom:8px;">
                <label>执行时间:</label>
                <input type="time" class="inp-time" value="${escapeHtml(task.time || '09:00')}">
            </div>
            <div style="font-size:12px; font-weight:600; color:#444; margin-bottom:8px;">
                步骤编辑（共 ${steps.length} 步）
            </div>
            <div class="edit-steps"></div>
            <div class="edit-actions">
                <button class="btn-add-wait">+ 等待步骤</button>
                <button class="btn-save-edit">保存</button>
                <button class="btn-cancel-edit">取消</button>
            </div>
        `;

        const stepsContainer = panel.querySelector('.edit-steps');

        function renderStepRow(step, i) {
            const row = document.createElement('div');
            row.className = 'edit-step';
            row.dataset.stepIndex = i;

            const isWait = step.type === 'wait';
            const isFill = step.type === 'fill' || step.type === 'select';

            row.innerHTML = `
                <div class="edit-step-index">${i + 1}</div>
                <div class="edit-step-body">
                    <div class="edit-step-head">
                        <span class="tag ${escapeHtml(step.type)}">${escapeHtml(step.type)}</span>
                        <span class="edit-step-desc">${escapeHtml(describeStep(step))}</span>
                        <button class="btn-del-step" data-step="${i}">删除</button>
                    </div>
                    <div class="edit-step-row">
                        <label>等待(ms):</label>
                        <input type="number" class="inp-wait" value="${step.waitAfter != null ? step.waitAfter : 800}" min="0" max="60000" step="100">
                    </div>
                    ${isFill ? `
                    <div class="edit-step-row">
                        <label>${step.type === 'select' ? '选项值:' : '输入值:'}</label>
                        <input type="text" class="inp-value" value="${escapeHtml(step.value || '')}">
                    </div>` : ''}
                    ${isWait ? `
                    <div class="edit-step-row">
                        <label>等待时长:</label>
                        <input type="number" class="inp-waitval" value="${step.value != null ? step.value : 1000}" min="100" max="60000" step="100">
                    </div>` : ''}
                </div>
            `;
            return row;
        }

        steps.forEach((step, i) => {
            stepsContainer.appendChild(renderStepRow(step, i));
        });

        // 删除步骤
        stepsContainer.addEventListener('click', (e) => {
            const delBtn = e.target.closest('.btn-del-step');
            if (!delBtn) return;
            const si = parseInt(delBtn.dataset.step);
            steps.splice(si, 1);
            // 重新渲染步骤列表
            stepsContainer.innerHTML = '';
            steps.forEach((s, i) => stepsContainer.appendChild(renderStepRow(s, i)));
            panel.querySelector('div[style*="font-weight:600"]').textContent =
                `步骤编辑（共 ${steps.length} 步）`;
        });

        // 添加等待步骤
        panel.querySelector('.btn-add-wait').addEventListener('click', () => {
            steps.push({ type: 'wait', value: 2000, waitAfter: 0 });
            stepsContainer.innerHTML = '';
            steps.forEach((s, i) => stepsContainer.appendChild(renderStepRow(s, i)));
            panel.querySelector('div[style*="font-weight:600"]').textContent =
                `步骤编辑（共 ${steps.length} 步）`;
        });

        // 取消
        panel.querySelector('.btn-cancel-edit').addEventListener('click', () => {
            panel.remove();
        });

        // 保存
        panel.querySelector('.btn-save-edit').addEventListener('click', () => {
            // 收集任务级字段
            const newName = panel.querySelector('.inp-name').value.trim();
            const newTimeVal = panel.querySelector('.inp-time').value;
            if (newName) tasks[taskIndex].name = newName;
            if (newTimeVal) tasks[taskIndex].time = newTimeVal;

            // 从 DOM 收集修改后的步骤
            const rows = stepsContainer.querySelectorAll('.edit-step');
            const newSteps = [];
            rows.forEach(row => {
                const si = parseInt(row.dataset.stepIndex);
                const step = { ...steps[si] };
                const waitInput = row.querySelector('.inp-wait');
                if (waitInput) step.waitAfter = parseInt(waitInput.value) || 0;
                const valInput = row.querySelector('.inp-value');
                if (valInput) step.value = valInput.value;
                const waitValInput = row.querySelector('.inp-waitval');
                if (waitValInput) step.value = parseInt(waitValInput.value) || 1000;
                newSteps.push(step);
            });

            tasks[taskIndex].steps = newSteps;
            saveTasks();
            renderTasks();
            showStatus('已保存');
        });

        itemEl.appendChild(panel);
    }

    // ===== 录制 =====
    btnRecord.addEventListener('click', () => {
        const url = newUrl.value.trim();
        const time = newTime.value;
        const name = newName.value.trim();

        if (!url) {
            showStatus('请输入网址', 'red');
            return;
        }
        if (!url.startsWith('http')) {
            showStatus('网址需以 http/https 开头', 'red');
            return;
        }

        chrome.runtime.sendMessage(
            { action: "start-recording", url, taskName: name, time },
            (response) => {
                if (response && response.success) {
                    showStatus('录制已启动，请在打开的页面中操作');
                    window.close();
                } else {
                    showStatus(response?.error || '启动录制失败', 'red');
                }
            }
        );
    });

    // 监听录制保存完成
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === "recording-saved") {
            loadTasks();
            showStatus('录制已保存为任务');
        }
    });

    // ===== 调试 =====
    btnReloadAlarms.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "update-alarms" }, () => {
            showStatus('定时已重载');
        });
    });

    btnRunAll.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: "trigger-all" });
        showStatus('已触发全部任务');
    });

    function showStatus(msg, color = '#888') {
        statusDiv.textContent = msg;
        statusDiv.style.color = color;
        setTimeout(() => { statusDiv.textContent = ""; }, 3000);
    }
});
