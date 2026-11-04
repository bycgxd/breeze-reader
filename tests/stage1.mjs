import {installFakePcm} from './fake-pcm.mjs';
import { collectRenderedMessage, observeRenderedMessage, visibleText } from '../rendered.mjs';

const results = document.querySelector('#test-results');
const checks = [];
function assert(condition, description) {
    if (!condition) throw new Error(description);
    checks.push('✓ ' + description);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
    const end = Date.now() + 4000;
    while (!predicate()) { if (Date.now() > end) throw new Error('等待检查结果超时'); await sleep(30); }
}
const activeObservers = new Set();
function trackObservers(view) {
    const Native = view.MutationObserver;
    view.MutationObserver = class extends Native {
        observe(...args) { activeObservers.add(this); return super.observe(...args); }
        disconnect() { activeObservers.delete(this); return super.disconnect(); }
    };
}

try {
    trackObservers(window);
    const chat = document.querySelector('#chat');
    function message(id, html) {
        const element = document.createElement('div');
        element.className = 'mes'; element.setAttribute('mesid', id);
        element.innerHTML = '<div class="mes_buttons"></div><div class="mes_text">' + html + '</div>';
        chat.append(element); return element;
    }
    const main = message(0, `<xmp id="dcSource" hidden>RAW_MUST_NOT_READ</xmp><div id="dcRoot">
      <div class="dc-narration-block"><p>清晨，阳光落在桌面上。<button>不要读按钮</button><span hidden>不要读隐藏文字</span><code>不要读代码</code></p></div>
      <div class="dc-msg" data-name="小夏" data-thought="0" data-mood-group="happy"><div class="dc-msg-header"><span class="dc-msg-name"><span>小</span><span>夏</span></span><span class="dc-msg-mood">开心</span></div><div class="dc-msg-text-content">今天的<strong>天气</strong>真好。</div><span class="dc-msg-quote">”不要读装饰</span></div>
      <div class="dc-msg" data-name="小夏" data-thought="1"><span class="dc-msg-name">小夏</span><span class="dc-msg-mood">期待</span><span class="dc-msg-text-content">（下午可以去公园走走。）</span></div>
      <div class="dc-narration-block" style="display:none">不要读隐藏段落</div>
    </div>`);
    const framed = message(1, '');
    async function addFrame(parent, html, opaque = false) {
        const frame = document.createElement('iframe');
        if (opaque) frame.setAttribute('sandbox','');
        const loaded = new Promise(resolve => frame.addEventListener('load',resolve,{once:true}));
        frame.srcdoc = html; parent.querySelector('.mes_text').append(frame); await loaded;
        if (!opaque) trackObservers(frame.contentWindow);
        return frame;
    }
    const frame = await addFrame(framed, '<div id="dcRoot"><div class="dc-narration-block"><p>他把书放回书架。</p></div></div>');
    const opaque = message(2, '');
    await addFrame(opaque, '<div id="dcRoot"><div class="dc-narration-block">不可访问的正文</div></div>', true);
    message(3, '<p>普通原文，不应被当成渲染结果。</p><xmp id="dcSource" hidden>RAW_MUST_NOT_READ</xmp>');
    const embedded = document.createElement('iframe'); embedded.className = 'dc-html-iframe';
    main.querySelector('#dcRoot').append(embedded);
    const before = main.innerHTML;
    const report = collectRenderedMessage(main);
    assert(report.blocks.map(block => block.kind).join(',') === 'narration,dialogue,thought', '按显示顺序识别旁白、对白与心理');
    assert(report.blocks[1].speaker === '小夏' && report.blocks[1].emotion === '开心' && report.blocks[1].emotionGroup === 'happy', '读取分字人物名、情绪与分组');
    assert(report.blocks[1].text === '今天的天气真好。', '正文保留富文本中的文字，排除姓名和装饰');
    assert(report.blocks[0].text === '清晨，阳光落在桌面上。', '排除隐藏文字、按钮和代码');
    assert(report.embeddedFrames === 1 && main.innerHTML === before, '跳过交互 iframe，采集不修改原 DOM');
    assert(collectRenderedMessage(framed).blocks[0].text === '他把书放回书架。', '读取同源 iframe 的渲染正文');
    assert(collectRenderedMessage(opaque).inaccessibleFrames === 1, '不可访问的 iframe 明确报告，不绕过权限');
    assert(collectRenderedMessage(chat.querySelector('[mesid="3"]')).blocks.length === 0, '未渲染消息不回退读取原文或隐藏源');
    const odd = document.createElement('p'); odd.textContent = '<img src=x onerror=alert(1)>';
    odd.dataset.testLiteral = '1';
    main.querySelector('.dc-narration-block').append(odd);
    assert(visibleText(odd) === '<img src=x onerror=alert(1)>', '按可见文字读取字符，不执行 HTML');

    let observed = '';
    const stopWatching = observeRenderedMessage(framed, data => { observed = data.blocks[0]?.text || ''; });
    frame.contentDocument.querySelector('p').textContent = '书架上的书排列整齐。';
    await until(() => observed === '书架上的书排列整齐。');
    assert(true, 'iframe 重渲染后更新识别结果');
    stopWatching();
    frame.contentDocument.querySelector('p').textContent = '这是停止观察之后的文字。';
    await sleep(220);
    assert(observed === '书架上的书排列整齐。' && activeObservers.size === 0, '停止后不再更新，观察器全部断开');
    let replacedText = '';
    const stopReplacement = observeRenderedMessage(main, data => { replacedText = data.blocks[0]?.text || ''; });
    const replacement = main.querySelector('.mes_text').cloneNode(true);
    replacement.querySelector('.dc-narration-block p').firstChild.nodeValue = '正文容器已经重新渲染。';
    main.querySelector('.mes_text').replaceWith(replacement);
    await until(() => replacedText.startsWith('正文容器已经重新渲染。'));
    assert(true, '整个正文容器被替换后仍重新识别');
    stopReplacement();

    const callbacks = new Map();
    const settings = {tts:{enabled:true,sentinel:'keep'},disabledExtensions:['foreign'],foreign:{keep:1}};
    const protectedSettings = JSON.stringify(settings);
    const events = ['APP_READY','CHARACTER_MESSAGE_RENDERED','MORE_MESSAGES_LOADED','CHAT_CHANGED','MESSAGE_DELETED','MESSAGE_EDITED','MESSAGE_SWIPED','GENERATION_STARTED','MESSAGE_RECEIVED','GENERATION_STOPPED','GENERATION_ENDED'];
    const ctx = {
        extensionSettings:settings, name2:'测试角色', characterId:0, characters:[{name:'测试角色'}],
        chat:[0,1,2,3].map(() => ({is_user:false,is_system:false,name:'测试角色',mes:'RAW_MUST_NOT_READ'})),
        saveSettingsDebounced(){},getRequestHeaders(){return {'Content-Type':'application/json'};},
        eventTypes:Object.fromEntries(events.map(key=>[key,key])),
        eventSource:{
            on(key,fn){if(!callbacks.has(key))callbacks.set(key,new Set());callbacks.get(key).add(fn);},
            removeListener(key,fn){callbacks.get(key)?.delete(fn);},
        },
    };

    window.SillyTavern = {getContext:()=>ctx};
    const harness=installFakePcm(),requests=harness.requests;
    const bridgeFetch=window.fetch;
    window.fetch=async(url,options)=>{if(String(url).endsWith('/speech')){requests.push(JSON.parse(options.body));return new Response('Test mode: no audio request sent',{status:503});}return bridgeFetch(url,options);};
    const sourceSnapshot = chat.innerHTML;
    const frameSnapshot = frame.contentDocument.body.innerHTML;
    const plugin = await import('../index.js');
    plugin.onEnable();
    const interactionObservers=activeObservers.size;
    assert(document.querySelectorAll('#br-bar').length === 1 && main.querySelectorAll('.br-preview-message').length === 1, '重复启用不重复添加工具条或按钮');
    const {breeze_reader,...unrelated} = settings;
    assert(JSON.stringify(unrelated) === protectedSettings && settings.tts.enabled, '不改变内置 TTS、其他设置或扩展状态');
    main.querySelector('.br-preview-message').click();
    assert(document.querySelectorAll('.br-preview-list li').length === 4 && requests.length === 0, '清单预览按句列出三类正文，不触发合成');
    assert(!document.querySelector('.br-preview-list img'), '清单用文字安全显示内容，不注入 HTML');
    document.querySelector('#breeze-reader [data-action="close"]').click();
    await sleep(40);
    assert(activeObservers.size === interactionObservers, '关闭预览立即释放预览观察器，保留正文交互监听');
    chat.querySelector('[mesid="3"] .br-message').click();
    assert(requests.length === 0 && document.querySelector('.br-preview-list').children.length === 0, '无渲染正文时阻止原始消息朗读');
    document.querySelector('#breeze-reader [data-action="close"]').click();
    main.querySelector('.br-message').click();
    await until(() => requests.length === 1);
    assert(!requests[0].input.includes('RAW_MUST_NOT_READ') && requests[0].input.includes('正文容器已经重新渲染。'), '朗读调用仅使用已识别的渲染正文首句');
    await until(() => document.querySelector('.br-status').textContent.includes('503'));
    plugin.onDisable();
    assert(chat.innerHTML === sourceSnapshot, '停用后原正文 DOM 与启用前完全一致');
    assert(frame.contentDocument.body.innerHTML === frameSnapshot, '停用后 iframe 内部正文也保持原样');
    assert(!document.querySelector('#breeze-reader,#br-bar,#br-settings,.br-message,.br-preview-message'), '停用后插件控件全部移除');
    assert(activeObservers.size === 0 && [...callbacks.values()].every(set=>set.size===0), '停用后观察器和酒馆事件监听全部清理');
    plugin.onEnable(); framed.querySelector('.br-preview-message').click(); plugin.onDisable();
    await sleep(220);
    assert(activeObservers.size === 0 && chat.innerHTML === sourceSnapshot, '再次启停不会留下观察器或 DOM 残留');
    results.textContent = '全部通过：' + checks.length + ' 项\n' + checks.join('\n');
    document.title = 'PASS · 轻声第一步验证';
    const demo = document.querySelector('#show-demo'); demo.hidden = false;
    demo.onclick = () => {
        main.querySelectorAll('[data-test-literal]').forEach(node=>node.remove());
        main.querySelector('.dc-narration-block p').firstChild.nodeValue = '清晨，阳光落在桌面上。';
        plugin.onEnable(); main.querySelector('.br-preview-message').click();
    };
} catch (error) {
    results.textContent = checks.join('\n') + '\n✗ ' + error.stack;
    document.title = 'FAIL · 轻声第一步验证';
}
