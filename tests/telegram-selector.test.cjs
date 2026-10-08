const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// 只导出内联定位函数，在隔离 DOM 桩中验证旧录制和可交互性。
const playerSource = fs.readFileSync(path.join(__dirname, '../player.js'), 'utf8');
const functions = playerSource.slice(playerSource.indexOf('    function getAccessibleName'), playerSource.indexOf('    function forceClick'));
const oldCss = '#column-center > div.chats-container.tabs-container:nth-of-type(1) > div.chat.tabs-tab > div.chat-input.chat-input-main:nth-of-type(4) > div.chat-input-container.chat-input-main-container > div.rows-wrapper-wrapper:nth-of-type(1) > div.rows-wrapper.chat-input-wrapper > div.new-message-wrapper.rows-wrapper-row:nth-of-type(8) > div.new-message-bot-commands:nth-of-type(1) > div.new-message-bot-commands-icon-scale:nth-of-type(1) > div.animated-menu-icon.animated-menu-close-icon';
const stableCss = '#column-center .chat-input-main .new-message-bot-commands';

function fixture({ hostname = 'web.telegram.org', buttons = [], top } = {}) {
    const queries = [];
    const ctx = vm.createContext({
        URL, location: { href: `https://${hostname}/k/#@Lewa_user_bot` },
        getComputedStyle: el => ({ visibility: 'visible', display: 'block', pointerEvents: 'auto', ...el.style }),
        document: {
            querySelectorAll(css) { queries.push(css); assert.equal(css, stableCss); return buttons; },
            querySelector(css) { queries.push(css); return null; },
            elementFromPoint: () => top === undefined ? buttons[0] : top
        }
    });
    vm.runInContext(functions, ctx);
    return { find: selector => ctx.findBySelector(selector), queries };
}
function button(style = {}) {
    return { style, getAttribute: () => null, contains(el) { return el === this; },
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 30, height: 30 }) };
}

test('old recorded icon path resolves to outer button despite changed layout', () => {
    const target = button();
    const f = fixture({ buttons: [target] });
    assert.equal(f.find({ css: oldCss, tag: 'div' }), target);
    assert.deepEqual(f.queries, [stableCss]);
});

test('new recordings use the same outer button', () => {
    const target = button();
    assert.equal(fixture({ buttons: [target] }).find({ kind: 'telegram-bot-commands', css: stableCss }), target);
});

test('hidden duplicate is ignored and visible button selected', () => {
    const hidden = button({ display: 'none' }), target = button();
    assert.equal(fixture({ buttons: [hidden, target], top: target }).find({ css: oldCss }), target);
});

test('absent, covered, disabled and offscreen buttons are not clicked', () => {
    assert.equal(fixture().find({ css: oldCss }), null);
    for (const target of [button({ visibility: 'hidden' }), button({ pointerEvents: 'none' }), { ...button(), disabled: true }]) {
        assert.equal(fixture({ buttons: [target] }).find({ css: oldCss }), null);
    }
    assert.equal(fixture({ buttons: [button()], top: button() }).find({ css: oldCss }), null);
    assert.equal(fixture({ buttons: [button()], top: null }).find({ css: oldCss }), null);
});

test('multiple interactive buttons are ambiguous and not clicked', () => {
    const first = button(), second = button();
    // A shared ancestor can be returned by hit testing; both candidates pass individually.
    assert.equal(fixture({ buttons: [first, second], top: { contains: () => true } }).find({ css: oldCss }), null);
});

test('Telegram-specific fallback never runs on other domains', () => {
    const f = fixture({ hostname: 'example.com', buttons: [button()] });
    assert.equal(f.find({ css: oldCss }), null);
    assert.deepEqual(f.queries, [oldCss]);
});

for (const file of ['recorder.js', 'selector.js']) {
    test(`${file} records the button rather than its internal icon`, () => {
        const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        const ctx = vm.createContext({ URL, location: { href: 'https://web.telegram.org/k/' }, window: {} });
        if (file === 'recorder.js') {
            vm.runInContext(src.slice(0, src.indexOf('    // ===== 录制状态')) + '\nwindow.buildSelector = buildSelector; })();', ctx);
        } else {
            vm.runInContext(src, ctx);
        }
        const build = ctx.window.buildSelector || ctx.buildSelector;
        const result = build({ closest(css) { assert.equal(css, stableCss); return {}; } });
        assert.equal(result.kind, 'telegram-bot-commands');
        assert.equal(result.css, stableCss);
        assert.equal(result.requireInteractive, true);
    });
}
