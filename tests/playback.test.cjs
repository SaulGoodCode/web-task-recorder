const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function clock() {
    let now = 0, next = 0;
    const timers = new Map();
    const set = (fn, ms, interval = 0) => {
        const id = ++next;
        timers.set(id, { fn, at: now + ms, interval });
        return id;
    };
    return {
        Date: class extends Date { static now() { return now; } },
        setTimeout: (fn, ms) => set(fn, ms),
        clearTimeout: id => timers.delete(id),
        setInterval: (fn, ms) => set(fn, ms, ms),
        clearInterval: id => timers.delete(id),
        async tick(ms) {
            const end = now + ms;
            for (;;) {
                for (let i = 0; i < 20; i++) await Promise.resolve();
                const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!entry) break;
                const [id, t] = entry;
                now = t.at;
                if (t.interval) t.at += t.interval;
                else timers.delete(id);
                t.fn();
            }
            now = end;
        }
    };
}
function event() {
    const listeners = new Set();
    return {
        addListener: fn => listeners.add(fn),
        removeListener: fn => listeners.delete(fn),
        emit: (...args) => [...listeners].forEach(fn => fn(...args))
    };
}
const quiet = { log() {}, warn() {}, error() {} };

function player(appearsAt) {
    const time = clock();
    let clicks = 0;
    const messages = [], warnings = [];
    const el = {
        scrollIntoView() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
        dispatchEvent() {}, click() { clicks++; }
    };
    const window = { __AUTO_TASK_PLAY__: { taskId: 'a', steps: [{ type: 'click', selector: { css: '#checkin' } }] } };
    const context = {
        ...time, window, console: { ...quiet, warn: text => warnings.push(text) },
        location: { href: 'https://web.telegram.org/k/#@test_bot' },
        document: { readyState: 'complete', visibilityState: 'hidden', documentElement: {},
            querySelector: () => time.Date.now() >= appearsAt ? el : null },
        MutationObserver: class { observe() {} disconnect() {} },
        PointerEvent: class {}, MouseEvent: class {},
        chrome: { runtime: { sendMessage: message => messages.push(message) } }
    };
    const done = vm.runInNewContext(source('player.js'), context);
    return { time, done, messages, warnings, window, clicks: () => clicks };
}

test('slow Telegram rendering after 25 seconds succeeds without repeating a click', async () => {
    const p = player(25000);
    await p.time.tick(30000);
    await p.done;
    assert.equal(p.clicks(), 1);
    assert.equal(p.messages[0].success, true);
});

test('missing element times out and reports selector and visibility', async () => {
    const p = player(Infinity);
    await p.time.tick(65000);
    await p.done;
    assert.equal(p.clicks(), 0);
    assert.equal(p.messages[0].success, false);
    assert.match(p.warnings[0], /#checkin/);
    assert.match(p.warnings[0], /visibility=hidden/);
});

test('cancelled player does not click an element that appears later', async () => {
    const p = player(25000);
    await p.time.tick(10000);
    p.window.__AUTO_TASK_CANCELLED__ = true;
    await p.time.tick(30000);
    await p.done;
    assert.equal(p.clicks(), 0);
    assert.equal(p.messages[0].success, false);
});

function background({ status = 'complete', steps = [{ type: 'click' }] } = {}) {
    const time = clock();
    const opened = [], injections = [], closed = [], lifecycle = [], statuses = [];
    let failInjection = false;
    const chrome = {
        runtime: { onInstalled: event(), onStartup: event(), onMessage: event() },
        alarms: { onAlarm: event(), create() {} },
        tabs: {
            onUpdated: event(),
            create(options, callback) { const tab = { id: opened.length + 1, status }; opened.push(tab); lifecycle.push(`open:${tab.id}`); callback(tab); },
            get: async id => opened.find(tab => tab.id === id),
            remove: async id => { await Promise.resolve(); closed.push(id); lifecycle.push(`close:${id}`); }
        },
        scripting: { async executeScript(options) { injections.push(options); if (failInjection) throw Error('injection failed'); } },
        storage: { sync: { get: (keys, cb) => cb({ tasks: [{ id: 'a', url: 'https://example.com', time: '09:00', steps }] }), set(value) { statuses.push(value.taskStatuses); } } }
    };
    const context = vm.createContext({ ...time, chrome, console: quiet });
    vm.runInContext(source('background.js'), context);
    return { time, chrome, opened, injections, closed, lifecycle, statuses, fail: () => { failInjection = true; },
        complete: (id, tabId, success) => chrome.runtime.onMessage.emit({ action: 'play-complete', taskId: id, success }, { tab: { id: tabId } }),
        run: id => context.performSignIn({ id, url: 'https://example.com', steps }, { scheduled: true }) };
}

for (const action of ['trigger-one', 'trigger-all']) {
    for (const success of [false, true]) {
        test(`${action} executes once and ${success ? 'closes successful' : 'retains failed'} tab`, async () => {
            const b = background();
            b.chrome.runtime.onMessage.emit({ action, taskId: 'a' }, {});
            await b.time.tick(2500);
            b.complete('a', 1, success);
            await b.time.tick(600000);
            assert.equal(b.opened.length, 1);
            assert.deepEqual(b.closed, success ? [1] : []);
            assert.equal(b.statuses[0].a.status, success ? 'success' : 'failed');
        });
    }
}

test('alarm entry point retains two retries', async () => {
    const b = background();
    b.fail();
    b.chrome.alarms.onAlarm.emit({ name: 'a' });
    await b.time.tick(15000);
    assert.equal(b.opened.length, 3);
    assert.deepEqual(b.closed, [1, 2]);
});

test('runs queue, deduplicate, and ignore completion from another tab', async () => {
    const b = background();
    const first = b.run('a');
    assert.equal(b.run('a'), first);
    const second = b.run('b');
    await b.time.tick(2500);
    assert.equal(b.opened.length, 1);
    assert.equal(b.injections.length, 2); // already-complete tab is injected
    b.chrome.runtime.onMessage.emit({ action: 'play-complete', taskId: 'a', success: true }, { tab: { id: 99 } });
    await b.time.tick(6000);
    assert.equal(b.opened.length, 1);
    b.chrome.runtime.onMessage.emit({ action: 'play-complete', taskId: 'a', success: true }, { tab: { id: 1 } });
    await b.time.tick(6000);
    assert.equal((await first).success, true);
    assert.equal(b.opened.length, 2);
    b.complete('b', 2, true);
    await b.time.tick(6000);
    assert.equal((await second).success, true);
});

test('injection failure retries twice then releases the queue', async () => {
    const b = background();
    b.fail();
    const first = b.run('a'), second = b.run('b');
    await b.time.tick(15000);
    assert.equal((await first).success, false);
    assert.equal((await second).success, false);
    assert.equal(b.opened.length, 6);
    assert.deepEqual(b.closed, [1, 2, 4, 5]);
});

for (const successfulAttempt of [1, 2, 3, null]) {
    test(`playback stops at ${successfulAttempt ? `success on attempt ${successfulAttempt}` : 'three failures and keeps final tab'}`, async () => {
        const b = background();
        const result = b.run('a');
        const count = successfulAttempt || 3;
        for (let attempt = 1; attempt <= count; attempt++) {
            await b.time.tick(2500);
            assert.equal(b.run('a'), result);
            assert.equal(b.opened.length, attempt);
            b.complete('a', attempt, attempt === successfulAttempt);
        }
        await b.time.tick(6000);
        assert.equal((await result).success, successfulAttempt !== null);
        assert.equal(b.opened.length, count);
        assert.deepEqual(b.closed, Array.from({ length: successfulAttempt ? count : 2 }, (_, i) => i + 1));
        const expected = [];
        for (let i = 1; i <= count; i++) {
            expected.push(`open:${i}`);
            if (successfulAttempt || i < 3) expected.push(`close:${i}`);
        }
        assert.deepEqual(b.lifecycle, expected);
        assert.equal(b.statuses.length, 1);
        assert.equal(b.statuses[0].a.status, successfulAttempt ? 'success' : 'failed');
        // 已清理的旧超时不能再启动重试或关闭保留页面。
        await b.time.tick(600000);
        assert.deepEqual(b.lifecycle, expected);
    });
}

test('three playback timeouts close only the first two tabs', async () => {
    const b = background();
    const result = b.run('a');
    await b.time.tick(550000);
    assert.equal((await result).success, false);
    assert.equal(b.opened.length, 3);
    assert.deepEqual(b.closed, [1, 2]);
});

test('URL-only load failures retry and retain third tab', async () => {
    const b = background({ status: 'loading', steps: [] });
    const result = b.run('a');
    await b.time.tick(95000);
    assert.equal((await result).success, false);
    assert.equal(b.opened.length, 3);
    assert.deepEqual(b.closed, [1, 2]);
});

test('URL-only success on retry closes both tabs and stops retrying', async () => {
    const b = background({ status: 'loading', steps: [] });
    const result = b.run('a');
    await b.time.tick(31000);
    b.chrome.tabs.onUpdated.emit(2, { status: 'complete' });
    await b.time.tick(6000);
    assert.equal((await result).success, true);
    assert.equal(b.opened.length, 2);
    assert.deepEqual(b.closed, [1, 2]);
});
