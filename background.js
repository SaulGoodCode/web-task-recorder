// background.js - 编排录制、播放、定时任务

// ===== 安装/启动 =====
chrome.runtime.onInstalled.addListener(() => {
    console.log("Extension Installed/Updated. Scheduling.");
    scheduleAll();
});
chrome.runtime.onStartup.addListener(() => {
    console.log("Browser Started. Scheduling.");
    scheduleAll();
});

// ===== 消息处理 =====
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
        case "update-alarms":
            scheduleAll();
            sendResponse({ status: "scheduled" });
            break;

        case "trigger-all":
            triggerAllNow();
            break;

        case "trigger-one":
            getTaskById(request.taskId).then(task => {
                if (task) performSignIn(task);
                else console.warn(`Task ${request.taskId} not found.`);
            });
            break;

        // ===== 录制相关 =====
        case "start-recording":
            startRecording(request.url, request.taskName, request.time).then(result => sendResponse(result));
            return true; // async

        case "recorder-save":
            finishRecording(request.steps);
            break;

        case "recorder-cancel":
            cancelRecording();
            break;

        // ===== 播放完成 =====
        case "play-complete":
            handlePlayComplete(request.taskId, request.success, sender.tab?.id);
            break;
    }
});

// ===== 定时调度 =====
async function scheduleAll() {
    await chrome.alarms.clearAll();
    const tasks = await getTasks();
    console.log(`Found ${tasks.length} tasks to schedule.`);
    for (const task of tasks) scheduleTask(task);
}

async function scheduleTask(task, forceNextDay = false) {
    const [hours, minutes] = task.time.split(':').map(Number);
    let targetTime = new Date();
    targetTime.setHours(hours, minutes, 0, 0);

    const offsetMinutes = (Math.random() * 10) - 5;
    const offsetMs = offsetMinutes * 60 * 1000;
    let randomizedTime = new Date(targetTime.getTime() + offsetMs);

    const now = new Date();
    if (forceNextDay || randomizedTime <= now) {
        targetTime.setDate(targetTime.getDate() + 1);
        randomizedTime = new Date(targetTime.getTime() + offsetMs);
    }

    console.log(`Scheduling task ${task.id} (${task.url}) for ${randomizedTime.toLocaleString()}`);
    chrome.alarms.create(task.id, { when: randomizedTime.getTime() });
}

chrome.alarms.onAlarm.addListener((alarm) => {
    console.log(`Alarm triggered: ${alarm.name}`);
    getTaskById(alarm.name).then(task => {
        if (task) {
            performSignIn(task);
            scheduleTask(task, true);
        } else {
            chrome.alarms.clear(alarm.name);
        }
    });
});

// ===== 播放执行 =====
function performSignIn(task) {
    return new Promise((resolve) => {
        console.log(`Performing task: ${task.name || task.url}`);
        let completed = false;

        // 若无步骤：打开网址，3 秒后正常加载完成则视为成功，否则失败
        if (!task.steps || task.steps.length === 0) {
            console.log(`Task ${task.id} has no steps, visiting URL only.`);
            chrome.tabs.create({ url: task.url, active: true }, (tab) => {
                const tabId = tab.id;
                let settled = false;

                // 监听页面加载状态：complete 视为成功
                const tabListener = (tabId_, changeInfo, tabObj) => {
                    if (tabId_ === tabId && changeInfo.status === 'complete' && !settled) {
                        chrome.tabs.onUpdated.removeListener(tabListener);
                        settled = true;
                        console.log(`Task ${task.id} URL loaded successfully.`);
                        updateTaskStatus(task.id, "success");
                        // 3 秒后关闭
                        setTimeout(() => {
                            chrome.tabs.remove(tabId).catch(() => { });
                            resolve({ success: true });
                        }, 3000);
                    }
                };
                chrome.tabs.onUpdated.addListener(tabListener);

                // 超时保护：30 秒未加载完成视为失败
                setTimeout(() => {
                    if (!settled) {
                        chrome.tabs.onUpdated.removeListener(tabListener);
                        settled = true;
                        console.warn(`Task ${task.id} URL failed to load within 30s.`);
                        updateTaskStatus(task.id, "failed");
                        chrome.tabs.remove(tabId).catch(() => { });
                        resolve({ success: false });
                    }
                }, 30000);
            });
            return;
        }

        chrome.tabs.create({ url: task.url, active: true }, (tab) => {
            const tabId = tab.id;

            // 完成监听
            const completionListener = (request, sender, sendResponse) => {
                if (request.action === "play-complete" && request.taskId === task.id) {
                    chrome.runtime.onMessage.removeListener(completionListener);
                    completed = true;
                    console.log(`Task ${task.id} completed, success: ${request.success}`);
                    updateTaskStatus(task.id, request.success ? "success" : "failed");
                    if (request.success) {
                        setTimeout(() => {
                            chrome.tabs.remove(tabId).catch(() => { });
                            resolve({ success: true });
                        }, 5000);
                    } else {
                        resolve({ success: false });
                    }
                }
            };
            chrome.runtime.onMessage.addListener(completionListener);

            // 超时保护
            setTimeout(() => {
                if (!completed) {
                    chrome.runtime.onMessage.removeListener(completionListener);
                    console.warn(`Task ${task.id} timed out (3min).`);
                    updateTaskStatus(task.id, "failed");
                    resolve({ success: false });
                }
            }, 180000);

            // 页面加载完成后注入 player
            const tabListener = (tabId_, changeInfo, tabObj) => {
                if (tabId_ === tabId && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(tabListener);
                    console.log("Tab loaded, injecting player...");
                    setTimeout(() => injectPlayer(tabId, task), 2000);
                }
            };
            chrome.tabs.onUpdated.addListener(tabListener);
        });
    });
}

// 注入播放器并执行步骤
async function injectPlayer(tabId, task) {
    try {
        // 先通过 executeScript 设置 window 变量，再注入 player.js 执行
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (taskId, steps) => {
                window.__AUTO_TASK_PLAY__ = { taskId, steps };
            },
            args: [task.id, task.steps]
        });
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["player.js"]
        });
        console.log(`Player injected for task ${task.id}`);
    } catch (err) {
        console.error(`Failed to inject player for task ${task.id}:`, err);
        updateTaskStatus(task.id, "failed");
    }
}

// 处理播放完成
function handlePlayComplete(taskId, success, tabId) {
    console.log(`Play complete: task ${taskId}, success: ${success}`);
    // 状态更新已在 completionListener 中处理
}

async function triggerAllNow() {
    const tasks = await getTasks();
    console.log(`Triggering all ${tasks.length} tasks sequentially...`);
    for (let i = 0; i < tasks.length; i++) {
        console.log(`Executing task ${i + 1}/${tasks.length}: ${tasks[i].name || tasks[i].url}`);
        await performSignIn(tasks[i]);
    }
    console.log("All tasks completed.");
}

// ===== 录制管理 =====
let recordingState = null; // { url, taskName, time, tabId }

async function startRecording(url, taskName, time) {
    if (recordingState) {
        return { success: false, error: "已有录制进行中" };
    }
    if (!url || !url.startsWith('http')) {
        return { success: false, error: "URL 无效" };
    }

    return new Promise((resolve) => {
        chrome.tabs.create({ url, active: true }, (tab) => {
            recordingState = { url, taskName, time: time || "09:00", tabId: tab.id };
            const tabListener = (tabId, changeInfo) => {
                if (tabId === tab.id && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(tabListener);
                    setTimeout(() => injectRecorder(tab.id), 1500);
                    resolve({ success: true });
                }
            };
            chrome.tabs.onUpdated.addListener(tabListener);
        });
    });
}

async function injectRecorder(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["recorder.js"]
        });
        console.log(`Recorder injected into tab ${tabId}`);
    } catch (err) {
        console.error(`Failed to inject recorder:`, err);
    }
}

async function finishRecording(steps) {
    if (!recordingState) {
        console.warn("finishRecording called but no recording in progress.");
        return;
    }
    const { url, taskName, time, tabId } = recordingState;

    // 添加初始 navigate 步骤
    const fullSteps = [{ type: 'navigate', url, waitAfter: 2000 }, ...steps];

    const task = {
        id: Date.now().toString(),
        name: taskName || url,
        url,
        time: time || "09:00",
        steps: fullSteps
    };

    const tasks = await getTasks();
    tasks.push(task);
    await new Promise(r => chrome.storage.sync.set({ tasks }, r));

    // 关闭录制 tab 并通知 UI
    chrome.tabs.remove(tabId).catch(() => { });
    chrome.runtime.sendMessage({ action: "recording-saved", task });
    recordingState = null;
    console.log(`Recording saved as task ${task.id} with ${fullSteps.length} steps, time: ${task.time}`);
}

function cancelRecording() {
    if (!recordingState) return;
    const { tabId } = recordingState;
    chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            const el = document.getElementById('autotask-recorder');
            if (el) el.remove();
            window.__AUTOTASK_RECORDER_LOADED__ = false;
        }
    }).catch(() => { });
    chrome.tabs.remove(tabId).catch(() => { });
    recordingState = null;
    console.log("Recording cancelled.");
}

// ===== 存储/状态辅助 =====
function getTasks() {
    return new Promise((resolve) => {
        chrome.storage.sync.get(['tasks'], (result) => resolve(result.tasks || []));
    });
}

function getTaskById(id) {
    return getTasks().then(tasks => tasks.find(t => t.id === id));
}

function updateTaskStatus(taskId, status) {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const timeStr = now.toLocaleString();
    chrome.storage.sync.get(['taskStatuses'], (result) => {
        const statuses = result.taskStatuses || {};
        statuses[taskId] = { status, lastExecuteDate: today, lastExecuteTime: timeStr };
        chrome.storage.sync.set({ taskStatuses: statuses });
    });
}
