import { DEFAULTS, cleanText, splitText, voiceFor, sentenceSpans, sentenceVoice, applyVoiceCatalog } from './core.mjs';
import { collectRenderedMessage, observeRenderedMessage, renderedSummary, makeSentences, renderedSignature } from './rendered.mjs';
import { createSentenceHighlighter } from './highlight.mjs';
import { createAudioCache, audioKey, CACHE_LIMIT } from './cache.mjs';
import { waitForStableReport } from './automation.mjs';
import {bridgeHealth,discoverVoices,readPcm,cachedPcm,pcmWav} from './stream.mjs';
import {connection} from './connection.mjs';
import {createStreamPlayer} from './stream-player.mjs';
import {createContentInteractions,selectedSentences} from './interaction.mjs';
import {startLocalService} from './startup.mjs';
import {attachIOSReader} from './ios-platform.mjs';
import {scopeItems,scopeStart} from './reading-scope.mjs';

const KEY = 'breeze_reader';
const LABELS = {dialogue:'对白',narration:'旁白 / 动作',thought:'心理活动'};
let runtime;

export function onEnable() {
    if (runtime) return;
    const context = () => SillyTavern.getContext();
    const ctx = context();
    const config = ctx.extensionSettings[KEY] ??= structuredClone(DEFAULTS);
    for (const [key,value] of Object.entries(DEFAULTS)) config[key] ??= structuredClone(value);
    config.autoMode ??= config.auto ? 'play' : 'manual';
    for(const key of ['streamEnabled','bufferMode','endpoint'])delete config[key];
    config.cacheNamespace ??= Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
    const save = () => context().saveSettingsDebounced();
    const cleanup = [];
    function listen(target,type,handler) {
        target.addEventListener(type,handler);
        cleanup.push(()=>target.removeEventListener(type,handler));
    }
    function subscribe(key,handler) {
        const type = ctx.eventTypes[key];
        if (!type) return;
        ctx.eventSource.on(type,handler);
        cleanup.push(()=>ctx.eventSource.removeListener(type,handler));
    }
    const root = document.createElement('div');
    root.id = 'breeze-reader';
    root.innerHTML = `
      <dialog class="br-panel" aria-labelledby="br-title">
        <header><div><small>LOCAL VOICE</small><h2 id="br-title">轻声</h2></div><button type="button" data-action="close" aria-label="关闭语音面板">×</button></header>
        <div class="br-body">
          <p class="br-intro">选择一句，或按正文顺序听下去。</p>
          <button type="button" data-action="start-service" class="br-primary">▶ 启动轻声</button><p class="br-service-status br-hint" role="status">启动或连接本机语音服务，已运行时自动复用。</p>
          <p class="br-conflict br-hint" hidden>酒馆内置 TTS 也已启用，可能同时出声。请自行选择使用哪一个；轻声不会更改它的设置。</p>
          <p class="br-status" role="status" aria-live="polite">准备好了</p>
          <div class="br-transport"><button type="button" data-action="previous" disabled>上一句</button><button type="button" data-action="pause" disabled>暂停</button><button type="button" data-action="next" disabled>下一句</button><button type="button" data-action="stop" disabled>停止</button><button type="button" data-action="retry" hidden>重试此句</button></div>
          <label class="br-follow-label"><input type="checkbox" class="br-follow">跟随朗读位置滚动</label><button type="button" data-action="follow-resume" hidden>恢复跟随</button>
          <p class="br-hint">PCM 流式播放：边生成边朗读，按音频时长自动缓冲。</p>
          <label class="br-follow-label"><input type="checkbox" class="br-content-interactions">启用正文快捷朗读</label>
          <label class="br-follow-label"><input type="checkbox" class="br-click-read">单击正文读本句（可选）</label>
          <label class="br-follow-label"><input type="checkbox" class="br-point-read">点读模式 · 单击正文从这里连续朗读</label>
          <p class="br-hint">选中文字后使用浮条；Alt + 点击从该句继续；正文右键可读本句。Shift + 右键保留浏览器菜单。</p>
          <details class="br-preview" open><summary>正文朗读清单</summary>
            <div class="br-preview-actions"><button type="button" data-action="preview-latest">识别最新回复</button><button type="button" data-action="refresh-preview" disabled>重新识别</button><button type="button" data-action="pregenerate">预生成本条</button><button type="button" data-action="cancel-background">取消预生成</button></div>
            <p class="br-preview-title">尚未选择消息</p><p class="br-preview-summary" role="status">点击消息旁的「朗读清单」，查看已渲染的对白、旁白/动作和心理活动。</p>
            <ol class="br-preview-list" aria-label="已识别的正文内容"></ol>
            <p class="br-hint">台词和心理活动按整个气泡朗读，旁白逐句朗读。原正文同步高亮；情绪标签当前仅作显示。</p>
          </details>
          <details class="br-casting" open><summary>多角色朗读设置</summary>
            <label class="br-follow-label"><input type="checkbox" class="br-dialogue-only">只读对白与心声（跳过旁白）</label>
            <p class="br-character"></p>
            <label class="br-field">朗读配音模式<select class="br-reading-mode" aria-label="朗读配音模式"><option value="multi">多角色配音 · 人物与旁白分别指定</option><option value="single">统一音色 · 全部使用默认声音</option></select></label>
            <label class="br-field">默认声音<select class="br-voice" aria-label="朗读音色"></select></label>
            <label class="br-field">旁白声音<select class="br-narrator" aria-label="旁白声音"></select></label>
            <label class="br-field">心理活动声音<select class="br-thought" aria-label="心理活动声音"></select></label>
            <div class="br-cast-list"></div>
            <label class="br-field">添加自定义人物<input class="br-new-speaker" maxlength="80" placeholder="输入已识别的人物名，例如：小夏" aria-label="自定义人物名"></label><button type="button" data-action="add-speaker">添加人物</button>
            <p class="br-hint">选择后自动保存到当前角色卡的轻声配音方案。人物名需与正文识别结果一致；未绑定的人物使用默认声音。心理活动默认跟随人物。</p>
          </details>
          <label class="br-field">新回复处理<select class="br-auto" aria-label="新回复处理"><option value="manual">手动播放 / 预生成</option><option value="prepare">新回复仅预生成</option><option value="play">新回复自动播放</option></select><small>只处理本次新生成且渲染稳定的正文</small></label>
          <label class="br-field">播放速度 <span class="br-rate-value"></span><input class="br-rate" type="range" min="0.6" max="1.6" step="0.05" aria-label="播放速度"></label>
          <section class="br-test"><label class="br-field">试一句<textarea class="br-test-text" rows="2" maxlength="2000" aria-label="试听文本">你好，今天也是适合听故事的一天。</textarea></label><button type="button" class="br-primary" data-action="test">▶ 试听 / 检测连接</button></section>
          <details class="br-cache"><summary>音频缓存</summary>
            <label class="br-follow-label"><input type="checkbox" class="br-cache-enabled">复用并保存音频缓存</label>
            <p class="br-cache-stats" role="status"></p><p class="br-cache-notice" role="status"></p>
            <div class="br-preview-actions"><button type="button" data-action="cache-refresh">查看用量</button><button type="button" data-action="cache-chat">清理当前聊天</button><button type="button" data-action="cache-all">清理我的轻声缓存</button></div>
            <p class="br-hint">本浏览器、当前账号独立保存，上限 500 MiB，超限淘汰较久未用音频。修改音色或文本只重新生成相关部分；同名音色的参考声音更换后请清理缓存。</p>
          </details>
          <details class="br-advanced"><summary>连接与音色管理</summary>
            <label class="br-field">轻声服务地址<input class="br-service-url" type="url" placeholder="http://电脑局域网IP:8789" aria-label="轻声服务地址"></label>
            <label class="br-field">连接密钥<input class="br-service-key" type="password" autocomplete="off" aria-label="轻声连接密钥"></label>
            <button type="button" data-action="save-connection">保存连接设置</button><button type="button" data-action="use-tavern-host">使用酒馆所在电脑</button>
            <p class="br-hint">留空使用本机接口。手机需填写运行模型的电脑地址，不能填 127.0.0.1。远程模式只检查连接；请先在电脑启动手机连接服务。密钥保存在当前账号的轻声设置中。</p>
            <button type="button" data-action="discover-voices">刷新本地音色</button><p class="br-discovery" role="status"></p>
            <details><summary>音色中文备注（可选）</summary><div class="br-voice-labels"></div><button type="button" data-action="save-labels">保存音色备注</button></details>
            <p class="br-hint">音色从指定目录自动获取。新增或替换 .breeze 文件后重启接口，再刷新列表。</p>
          </details>
        </div>
      </dialog>`;
    document.body.append(root);
    const panel = root.querySelector('dialog');
    const bar = document.createElement('div');
    bar.id = 'br-bar';
    bar.innerHTML = `<button type="button" data-action="open" class="br-brand" aria-haspopup="dialog">◖ 轻声</button><select class="br-voice" aria-label="聊天朗读音色"></select><button type="button" data-action="preview-latest">朗读清单</button><button type="button" data-action="latest">▶ 最新回复</button><button type="button" data-action="previous" disabled>上一句</button><button type="button" data-action="pause" disabled>暂停</button><button type="button" data-action="next" disabled>下一句</button><button type="button" data-action="stop" disabled>停止</button><button type="button" data-action="retry" hidden>重试此句</button><button type="button" data-action="follow-resume" hidden>恢复跟随</button><span class="br-bar-status" role="status">仅朗读已识别的渲染正文</span>`;
    const settings = document.createElement('div');
    settings.id = 'br-settings';
    settings.innerHTML = '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>轻声 · 本地朗读</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><button type="button" class="menu_button" data-action="start-service">▶ 启动轻声</button><button type="button" class="menu_button" data-action="open">打开轻声</button><p class="br-service-status" role="status">点击启动或连接本机语音服务。</p></div></div>';
    let disposed = false, player, contentInteraction, playbackSelection=false, previewId = null, previewElement, stopPreview, stopSourceWatch;
    let previewSentences = [], lastReport, playbackSignature = '', following = config.follow;
    let generating = false, pendingId = null;
    let background, cacheHits=0, cacheMisses=0;
    const cache = createAudioCache(config.cacheNamespace,{onWarning(message){if(!disposed)root.querySelector('.br-cache-notice').textContent=message;}});
    const bridgeController=new AbortController();cleanup.push(()=>bridgeController.abort());
    let startupController;
    cleanup.push(()=>startupController?.abort());
    function serviceStatus(text,error=false){if(disposed)return;for(const host of [root,settings]){const label=host.querySelector('.br-service-status');label.textContent=text;label.classList.toggle('br-error',error);}}
    async function startService(){
        if(startupController)return;
        stop('');const controller=startupController=new AbortController();
        for(const host of [root,settings]){const button=host.querySelector('[data-action="start-service"]');button.disabled=true;button.textContent='正在启动…';}
        try{
            await startLocalService({signal:controller.signal,onProgress:text=>serviceStatus(text),config});
            if(controller.signal.aborted||disposed)return;
            const count=await refreshVoices();
            serviceStatus(count?`轻声已就绪 · 已读取 ${count} 个音色。`:'模型已启动，音色读取未完成，请点击刷新音色。',!count);
        }catch(error){if(!controller.signal.aborted)serviceStatus(error.message||'轻声启动失败，请重试。',true);}
        finally{
            if(startupController===controller)startupController=undefined;
            if(!disposed)for(const host of [root,settings]){const button=host.querySelector('[data-action="start-service"]');button.disabled=false;button.textContent=connection(config).local?'▶ 启动轻声':'连接轻声';}
        }
    }
    let discovering,voiceAliases=new Map();
    async function refreshVoices(){
        if(discovering)return discovering;
        discovering=(async()=>{
            try{
                const result=await discoverVoices(AbortSignal.any([bridgeController.signal,AbortSignal.timeout(8000)]),config);if(disposed)return;
                const loaded=result.voices.filter(row=>row.loaded),missing=result.voices.length-loaded.length;
                if(!loaded.length)throw new Error('指定文件夹中没有已加载音色，请添加 .breeze 文件后重启接口。');
                const aliases=applyVoiceCatalog(config,loaded);
                for(const [oldId,id]of voiceAliases)if(config.voices.includes(id)&&!aliases.has(oldId))aliases.set(oldId,id);
                voiceAliases=aliases;
                save();sync();if(lastReport)renderPreview(lastReport);
                root.querySelector('.br-discovery').textContent=`已获取 ${loaded.length} 个音色 · ${result.voiceDirectory}${missing?` · ${missing} 个新音色需重新运行「启动轻声」后加载`:''}`;
                return loaded.length;
            }catch(error){if(!disposed&&!bridgeController.signal.aborted)root.querySelector('.br-discovery').textContent='请点击「启动轻声」，就绪后再刷新音色。'+error.message;return 0;}
            finally{discovering=undefined;}
        })();return discovering;
    }
    function owner() { const c=context();return JSON.stringify([profileKey(),c.chatId ?? c.getCurrentChatId?.() ?? 'current']); }
    async function cacheStats() {
        const stats=await cache.stats();
        if(!disposed)root.querySelector('.br-cache-stats').textContent=`${stats.count} 段 · ${(stats.bytes/1048576).toFixed(1)} / ${CACHE_LIMIT/1048576} MiB · ${stats.persistent?'浏览器持久缓存':'临时内存缓存'} · 本次命中 ${cacheHits} / 生成 ${cacheMisses}`;
    }
    function cancelBackground() {background?.abort();background=undefined;}
    const highlighter = createSentenceHighlighter();
    function messageElement(id) { return document.querySelector(`#chat .mes[mesid="${Number(id)}"]`); }
    function character() { const c = context(); return c.characters[c.characterId]?.name || ''; }
    function profileKey() {
        const c = context();
        return c.groupId ? `group:${c.groupId}` : c.characters[c.characterId]?.avatar || (character() ? `name:${character()}` : 'default');
    }
    function profile() { return config.profiles[profileKey()] || {voices:{}}; }
    function editProfile() { const p = config.profiles[profileKey()] ??= {voices:{}}; p.voices ??= {}; return p; }
    function fallbackVoice() { const voice=profile().defaultVoice || voiceFor(config,character());return config.voices.includes(voice)?voice:config.voice; }
    function voiceName(voice){voice=voiceAliases.get(voice)||voice;const name=Object.hasOwn(config.voiceNames,voice)?config.voiceNames[voice]:voice,label=Object.hasOwn(config.voiceLabels,voice)?config.voiceLabels[voice]:'';return label&&label!==name?`${name} · ${label}`:name;}
    const inScope=items=>scopeItems(items,config.dialogueOnly===true);
    function assignVoices(items) { return items.map((item,index)=>{const voice=sentenceVoice(profile(),item,fallbackVoice());return {...item,sourceIndex:item.sourceIndex??index,voice:config.voices.includes(voice)?voice:fallbackVoice()};}); }
    function status(message,error = false) {
        if (disposed) return;
        root.querySelector('.br-status').textContent = message;
        root.querySelector('.br-status').classList.toggle('br-error',error);
        bar.querySelector('.br-bar-status').textContent = message;
    }
    function controls(state = player?.state) {
        if (!state || disposed) return;
        for (const host of [root,bar]) {
            host.querySelector('[data-action="previous"]').disabled = state.index <= 0;
            host.querySelector('[data-action="next"]').disabled = !state.items.length || state.index + 1 >= state.items.length;
            host.querySelector('[data-action="pause"]').disabled = !state.active;
            host.querySelector('[data-action="pause"]').textContent = state.paused || state.phase === 'ready' ? '继续' : '暂停';
            host.querySelector('[data-action="stop"]').disabled = !state.items.length;
            host.querySelector('[data-action="retry"]').hidden = state.phase !== 'error';
            host.querySelector('[data-action="follow-resume"]').hidden = !config.follow || following;
        }
        for (const button of document.querySelectorAll('.br-message')) {
            const active = state.active && Number(button.closest('.mes')?.getAttribute('mesid')) === state.messageId;
            button.textContent = active ? '■ 停止' : '▶ 朗读';
            button.setAttribute('aria-pressed',String(active));
        }
        for (const item of root.querySelectorAll('.br-preview-list li')) {
            const selected = state.messageId === previewId && Number(item.dataset.sentence) === previewSentences.findIndex(item=>item.sourceIndex===(state.items[state.index]?.sourceIndex??state.index));
            item.dataset.state = selected ? state.phase : '';
            item.setAttribute('aria-current',String(selected && ['playing','paused'].includes(state.phase)));
        }
    }
    function onState(state) {
        if (!state.active) { stopSourceWatch?.(); stopSourceWatch = undefined; }
        if (disposed) return;
        controls(state);
        const item = state.items[state.index];
        const description = item ? `第 ${state.index+1}/${state.items.length} 句${state.part > 1 ? ` · 小段 ${state.part}` : ''} · ${item.speaker || '旁白'} · ${voiceName(item.voice)}` : '';
        const phases = {idle:'准备好了',buffering:`流式缓冲 · 已准备 ${state.buffered.toFixed(1)} 秒`,playing:'正在流式朗读',paused:'已暂停',finished:'朗读完成'};
        status(state.phase === 'error' ? `${description}：${state.error} 可重试或跳到下一句。` : `${phases[state.phase] || ''}${description ? ' · '+description : ''}`,state.phase === 'error');
    }
    async function synthesize(text,voice,signal) {
        const parts=[];for await(const part of streamSamples(text,voice,signal))parts.push(part);return pcmWav(parts);
    }
    async function* streamSamples(text,voice,signal){
        if(discovering)await discovering;
        signal.throwIfAborted();
        voice=voiceAliases.get(voice)||voice;
        const remote=connection(config);
        const scope=owner(),version=cache.epoch,key=await audioKey(remote.base+'/pcm-v1/'+(config.voiceRevisions[voice] || 'unknown'),voice,text);
        signal.throwIfAborted();
        if(config.cacheEnabled){const saved=await cache.get(key,scope);signal.throwIfAborted();if(saved){cacheHits++;yield* cachedPcm(saved);return;}}
        let health;
        health=await bridgeHealth(signal,config);
        const response=await fetch(remote.base+'/speech',{method:'POST',headers:{...remote.headers,'Content-Type':'application/json','X-Breeze-Token':health.token},body:JSON.stringify({input:text,voice}),signal,credentials:'omit'});
        const parts=[];let received=0;
        for await(const samples of readPcm(response)){signal.throwIfAborted();received+=samples.length;if(config.cacheEnabled)parts.push(samples);yield samples;}
        if(!received)throw new Error('模型返回了空的 PCM 音频。');
        cacheMisses++;signal.throwIfAborted();if(config.cacheEnabled)await cache.put(key,scope,pcmWav(parts),version);
    }
    player=createStreamPlayer({
        ios:{
            async prepare(items){
                if(discovering)await discovering;
                const remote=connection(config),scope=owner(),version=cache.epoch;
                const planned=[];
                for(let index=0;index<items.length;index++){
                    const item=items[index],voice=voiceAliases.get(item.voice)||item.voice,segments=[];
                    for(const input of splitText(item.text))segments.push({input,voice,key:await audioKey(remote.base+'/pcm-v1/'+(config.voiceRevisions[voice]||'unknown'),voice,input)});
                    planned.push({index,id:item.id,text:item.text,speaker:item.speaker||'旁白',kind:item.kind||'dialogue',emotion:item.emotion||'',segments});
                }
                return {base:remote.base,key:remote.headers['X-Breeze-Key']||'',cacheEnabled:config.cacheEnabled,cacheScope:scope,cacheVersion:version,items:planned};
            },
            unreadable(){root.querySelector('.br-cache-notice').textContent='部分旧音频缓存无法读取，本次将重新合成这些片段。';},
            async cached(key,plan){if(!config.cacheEnabled)return null;const blob=await cache.get(key,plan.cacheScope);if(blob)cacheHits++;return blob;},
            async store(key,blob,plan){cacheMisses++;if(config.cacheEnabled&&plan)await cache.put(key,plan.cacheScope,blob,plan.cacheVersion);}
        },
        async *generate(item,signal){for(const text of splitText(item.text))yield* streamSamples(text,item.voice,signal);},
        rate:()=>config.rate,onState,clearHighlight:()=>highlighter.clear(),
        onStart(item){if(item.element)highlighter.show(item,following);},
        valid(item){
            if(!item.element)return true;
            const report=collectRenderedMessage(messageElement(player.state.messageId));
            return item.element.isConnected && report.blocks.some(block=>block.element===item.element) && item.ranges.every(range=>range.startContainer.isConnected&&range.endContainer.isConnected) && renderedSignature(report.blocks)===playbackSignature;
        },
    });
    function stop(message = '已停止', handoff = false) {
        contentInteraction?.hide();playbackSelection=false;
        cancelBackground();
        stopSourceWatch?.(); stopSourceWatch = undefined;
        player.stop(handoff&&globalThis.__nativeIOSReader?.cacheHandoff===true?'handoff':'original-stop');
        if (message) status(message);
    }
    async function prepare(id) {
        stop('');
        if(!config.cacheEnabled){status('请先开启音频缓存，再预生成。',true);return;}
        const element=messageElement(id),report=collectRenderedMessage(element);
        if(!report.blocks.length || report.loadingFrames || report.inaccessibleFrames){status(renderedSummary(report),true);return;}
        const items=inScope(assignVoices(makeSentences(report.blocks)));
        if(!items.length){status(config.dialogueOnly?'当前消息没有可朗读的角色对白或心声。':'请选择有效的句子。',true);return;}
        const ctrl=background=new AbortController(),signature=renderedSignature(report.blocks),chatOwner=owner();
        const unwatch=observeRenderedMessage(element,next=>{if(signature!==renderedSignature(next.blocks)){ctrl.abort();if(background===ctrl)status('正文已变化，已取消旧的预生成。');}});
        try {
            let count=0,bytes=0;
            for(const item of items)for(const text of splitText(item.text)) {
                ctrl.signal.throwIfAborted();if(owner()!==chatOwner)throw new DOMException('Aborted','AbortError');
                status(`预生成 · 已准备 ${count} 段`);
                const blob=await synthesize(text,item.voice,ctrl.signal);ctrl.signal.throwIfAborted();
                count++;bytes+=blob.size;
                if(bytes>=CACHE_LIMIT){status('已达到本次预生成容量上限；其余内容将在播放时生成。');return;}
            }
            status(`预生成完成 · ${count} 段，点击朗读即可复用。`);
        }catch(error){if(!ctrl.signal.aborted)status(error.message,true);}
        finally{unwatch();if(background===ctrl)background=undefined;cacheStats();}
    }
    async function processNewReply(id) {
        stop('');const ctrl=background=new AbortController();
        try{
            await waitForStableReport(()=>collectRenderedMessage(messageElement(id)),renderedSignature,ctrl.signal);
            ctrl.signal.throwIfAborted();if(disposed)return;
            background=undefined;
            if(config.autoMode==='play')readMessage(id,{manual:false,toggle:false});
            else if(config.autoMode==='prepare')await prepare(id);
        }catch(error){if(!ctrl.signal.aborted)status(error.message,true);}
        finally{if(background===ctrl)background=undefined;}
    }
    function manualScroll(event) {
        if (!config.follow || !following || event.target.closest?.('#breeze-reader,#br-bar')) return;
        if (event.type === 'keydown' && !['PageUp','PageDown','Home','End','ArrowUp','ArrowDown',' '].includes(event.key)) return;
        following = false; controls();
    }
    function watchPlayback(element,report) {
        const remove = observeRenderedMessage(element,next=>{
            if (!player.state.active) return;
            const elements=new Set(next.blocks.map(block=>block.element));
            const stale = player.state.items.some(item=>!elements.has(item.element)||item.ranges?.some(range=>!range.startContainer.isConnected));
            if (stale || renderedSignature(next.blocks) !== playbackSignature) stop('正文已变化，已停止旧语音。请重新识别后播放。');
        });
        const docs = new Set([document,...report.blocks.map(block=>block.content.ownerDocument)]);
        for (const doc of docs) for (const type of ['wheel','touchmove','keydown']) doc.addEventListener(type,manualScroll,{passive:true});
        return () => { remove(); for (const doc of docs) for (const type of ['wheel','touchmove','keydown']) doc.removeEventListener(type,manualScroll); };
    }
    function readMessage(id,{start=0,single=false,manual=true,toggle=true,sourceStart=false} = {}) {
        const message = context().chat[id];
        if (!message || message.is_user || message.is_system) return;
        if (toggle && player.state.active && player.state.messageId === id) { stop(); return; }
        const element = messageElement(id);
        const report = collectRenderedMessage(element);
        if (!report.blocks.length || report.inaccessibleFrames || report.loadingFrames) {
            stop('');status(renderedSummary(report),true); if (manual) preview(id); return;
        }
        const items = inScope(assignVoices(makeSentences(report.blocks)));
        const position=scopeStart(items,start,{sourceStart,single});
        if(position<0){if(config.dialogueOnly)stop('此处没有可朗读的角色对白或心声，已跳过旁白。');else status('正文句子已变化，请重新选择。',true);return;}
        startReading(id,report,items,{start:position,single});
    }
    function startReading(id,report,items,{start=0,single=false,selection=false}={}){
        stop('',true);playbackSelection=selection;
        playbackSignature = renderedSignature(report.blocks); following = config.follow;
        player.start(items,{start,single,messageId:id});
        if (player.state.active) stopSourceWatch = watchPlayback(messageElement(id),report);
        if (panel.open && innerWidth <= 640) panel.close();
    }
    function readContent(snapshot,action){
        if(!snapshot)return;
        const element=messageElement(snapshot.messageId),report=collectRenderedMessage(element);
        if(!element || renderedSignature(report.blocks)!==snapshot.signature){status('正文已变化，请重新选择后朗读。',true);return;}
        if(action!=='selection'){readMessage(snapshot.messageId,{start:snapshot.firstIndex,single:action==='sentence',toggle:false,sourceStart:true});return;}
        const items=inScope(assignVoices(selectedSentences(makeSentences(report.blocks),snapshot.range)));
        if(!items.length){if(config.dialogueOnly)stop('选区没有可朗读的角色对白或心声。');else status('选中文字已失效，请重新选择。',true);return;}
        startReading(snapshot.messageId,report,items,{selection:true});
    }
    function restartExcerpt(action){
        const state=player.state,element=messageElement(state.messageId),report=collectRenderedMessage(element);
        if(!element || renderedSignature(report.blocks)!==playbackSignature || state.items.some(item=>!item.element?.isConnected||!report.blocks.some(block=>block.element===item.element)||item.ranges.some(range=>!range.startContainer.isConnected||!range.endContainer.isConnected))){stop('正文已变化，请重新选择后朗读。');return;}
        player[action]();
        if(player.state.active){stopSourceWatch?.();stopSourceWatch=watchPlayback(element,report);}
    }
    function readTest() {
        stop('');
        const items = sentenceSpans(cleanText(root.querySelector('.br-test-text').value)).map((span,index)=>({...span,id:`test${index}`,voice:fallbackVoice(),kind:'dialogue',speaker:'试听'}));
        if (!items.length) { status('请输入可朗读的文字。'); return; }
        player.start(items);
    }
    function latestId() { return context().chat.findLastIndex(message=>!message.is_user && !message.is_system); }
    function voiceOptions(select,value,inherit) {
        const options = config.voices.map(voice=>new Option(voiceName(voice),voice));
        if (inherit) options.unshift(new Option(inherit,''));
        if(value && !config.voices.includes(value)){const missing=new Option(`${value}（不可用，朗读时用默认声音）`,value);missing.disabled=true;options.push(missing);}
        select.replaceChildren(...options); select.value = value || '';
    }
    function renderCasting() {
        const p = profile();
        const single=p.mode==='single';
        root.querySelector('.br-reading-mode').value=single?'single':'multi';
        voiceOptions(root.querySelector('.br-narrator'),p.narrator,'跟随默认声音');
        voiceOptions(root.querySelector('.br-thought'),p.thought,'跟随人物声音');
        const speakers = new Map();
        for (const item of previewSentences) if (item.speakerKey || item.speaker) speakers.set((item.speakerKey || item.speaker).trim().toLowerCase(),item.speaker || item.speakerKey);
        for(const key of Object.keys(p.voices || {}))if(!speakers.has(key))speakers.set(key,Object.hasOwn(p.names || {},key)?p.names[key]:key);
        const rows = [...speakers].map(([key,name])=>{
            const row=document.createElement('div');row.className='br-cast-row';
            const label = document.createElement('label'); label.className = 'br-field'; label.textContent = name;
            const select = document.createElement('select'); select.dataset.speaker = key; select.setAttribute('aria-label',`人物音色：${name}`);
            voiceOptions(select,Object.hasOwn(p.voices || {},key) ? p.voices[key] : '','跟随默认声音'); label.append(select);row.append(label);
            if(Object.hasOwn(p.voices || {},key)){const remove=document.createElement('button');remove.type='button';remove.dataset.action='remove-speaker';remove.dataset.speakerKey=key;remove.textContent='清除绑定';remove.setAttribute('aria-label',`清除配音绑定：${name}`);row.append(remove);}
            return row;
        });
        if (!rows.length) {
            const hint = document.createElement('p'); hint.className = 'br-hint'; hint.textContent = '识别正文后自动列出人物，也可在下方提前添加。'; rows.push(hint);
        }
        root.querySelector('.br-cast-list').replaceChildren(...rows);
        for(const select of root.querySelectorAll('.br-narrator,.br-thought,[data-speaker]'))select.disabled=single;
    }
    function clearPreview() {
        stopPreview?.(); stopPreview = undefined; previewId = null; previewElement = undefined; lastReport = undefined; previewSentences = [];
        root.querySelector('.br-preview-title').textContent = '尚未选择消息';
        root.querySelector('.br-preview-summary').textContent = '点击消息旁的「朗读清单」，查看已渲染正文。';
        root.querySelector('.br-preview-list').replaceChildren();
        root.querySelector('[data-action="refresh-preview"]').disabled = true; renderCasting();
    }
    function renderPreview(report) {
        if (disposed) return;
        lastReport = report; previewSentences = inScope(assignVoices(makeSentences(report.blocks)));
        root.querySelector('.br-preview-title').textContent = `消息 #${previewId} · ${previewSentences.length} 句`;
        root.querySelector('.br-preview-summary').textContent = renderedSummary(report)+(config.dialogueOnly?' · 只读对白与心声，跳过旁白':'');
        const items = previewSentences.map((sentence,index)=>{
            const item = document.createElement('li'); item.dataset.sentence = index;
            const meta = document.createElement('div'); meta.className = 'br-preview-meta';
            meta.textContent = [LABELS[sentence.kind],sentence.speaker,sentence.emotion && `情绪：${sentence.emotion}`,`声音：${voiceName(sentence.voice)}`].filter(Boolean).join(' · ');
            const text = document.createElement('p'); text.textContent = sentence.text;
            const actions = document.createElement('div'); actions.className = 'br-sentence-actions';
            for (const [action,title] of [['sentence','▶ 本句'],['from-here','从这里继续']]) {
                const button = document.createElement('button'); button.type = 'button'; button.dataset.action = action; button.dataset.index = index; button.textContent = title; actions.append(button);
            }
            item.append(meta,text,actions); return item;
        });
        root.querySelector('.br-preview-list').replaceChildren(...items); renderCasting(); controls();
    }
    function bindPreview(id) {
        stopPreview?.(); stopPreview = undefined; previewId = Number(id);
        root.querySelector('[data-action="refresh-preview"]').disabled = false;
        const message = previewElement = messageElement(id);
        if (!message) { renderPreview(collectRenderedMessage(null)); return; }
        stopPreview = observeRenderedMessage(message,renderPreview);
    }
    function open() {
        sync(); if (!panel.open) panel.show();
        if (previewId !== null) bindPreview(previewId);
    }
    function preview(id) { open(); root.querySelector('.br-preview').open = true; bindPreview(id); }
    function sync() {
        root.querySelector('.br-service-url').value=config.serviceUrl;
        root.querySelector('.br-service-key').value=config.serviceKey;
        for(const host of [root,settings])host.querySelector('[data-action="start-service"]').textContent=connection(config).local?'▶ 启动轻声':'连接轻声';
        for (const select of [root.querySelector('.br-voice'),bar.querySelector('.br-voice')]) voiceOptions(select,fallbackVoice());
        root.querySelector('.br-character').textContent = character() ? `配音保存到当前角色卡：${character()}` : '当前使用默认配音方案';
        root.querySelector('.br-auto').value = config.autoMode;
        root.querySelector('.br-dialogue-only').checked=config.dialogueOnly===true;
        root.querySelector('.br-cache-enabled').checked = config.cacheEnabled;
        const labels=config.voices.map(voice=>{const label=document.createElement('label');label.className='br-field';label.textContent=`${config.voiceNames[voice] || voice} 的备注`;const input=document.createElement('input');input.dataset.voiceLabel=voice;input.maxLength=40;input.value=config.voiceLabels[voice] || '';label.append(input);return label;});
        root.querySelector('.br-voice-labels').replaceChildren(...labels);
        root.querySelector('.br-follow').checked = config.follow;
        root.querySelector('.br-content-interactions').checked=config.contentInteractions;
        root.querySelector('.br-click-read').checked=config.clickToRead;
        root.querySelector('.br-click-read').disabled=!config.contentInteractions;
        root.querySelector('.br-point-read').checked=!!config.tapToContinue;
        root.querySelector('.br-point-read').disabled=!config.contentInteractions;
        root.querySelector('.br-conflict').hidden = !context().extensionSettings.tts?.enabled;
        root.querySelector('.br-rate').value = config.rate; root.querySelector('.br-rate-value').textContent = `${Number(config.rate).toFixed(2)}×`;
        renderCasting(); controls();cacheStats();
    }
    function decorate() {
        for (const message of document.querySelectorAll('#chat .mes[mesid]')) {
            const id = Number(message.getAttribute('mesid')); const data = context().chat[id]; const buttons = message.querySelector('.mes_buttons');
            if (!buttons || !data || data.is_user || data.is_system) continue;
            if (!message.querySelector('.br-preview-message')) {
                const button = document.createElement('button'); button.type = 'button'; button.className = 'br-preview-message'; button.textContent = '朗读清单'; button.setAttribute('aria-haspopup','dialog'); buttons.prepend(button);
            }
            if (!message.querySelector('.br-message')) {
                const button = document.createElement('button'); button.type = 'button'; button.className = 'br-message'; button.textContent = '▶ 朗读'; button.title = '朗读已渲染正文'; button.setAttribute('aria-pressed','false'); buttons.prepend(button);
            }
        }
        if (player.state.active && player.state.items.some(item=>item.element && !item.element.isConnected)) stop('正文已重新渲染，已停止旧语音。');
        if (panel.open && previewId !== null && messageElement(previewId) !== previewElement) bindPreview(previewId);
        contentInteraction?.refresh();
    }
    function attach() {
        const form = document.getElementById('send_form'); if (form && !bar.isConnected) form.before(bar);
        const host = document.querySelector('#extensions_settings2,#extensions_settings'); if (host && !settings.isConnected) host.prepend(settings);
        decorate();
    }
    function action(event) {
        const button = event.target.closest('[data-action]'); if (!button) return;
        switch (button.dataset.action) {
            case 'open': open(); break;
            case 'close': stopPreview?.();stopPreview=undefined;panel.close(); break;
            case 'stop': stop(); break;
            case 'pause': if (player.state.paused || player.state.phase === 'ready') player.resume(); else player.pause(); break;
            case 'previous': case 'next': {
                const state = player.state;
                const start = state.index + (button.dataset.action === 'previous' ? -1 : 1);
                if(playbackSelection)restartExcerpt(button.dataset.action);
                else if (state.messageId !== null) readMessage(state.messageId,{start,single:state.single,toggle:false});
                else if (button.dataset.action === 'previous') player.previous(); else player.next();
                break;
            }
            case 'retry': {
                const state = player.state;
                if(playbackSelection)restartExcerpt('retry');
                else if (state.messageId !== null) readMessage(state.messageId,{start:state.index,single:state.single,toggle:false}); else player.retry();
                break;
            }
            case 'follow-resume': following = true; controls(); highlighter.reveal(); break;
            case 'test': readTest(); break;
            case 'start-service': startService();break;
            case 'use-tavern-host': {
                const url=new URL(location.href);url.port='8789';url.pathname='/';url.search='';url.hash='';
                root.querySelector('.br-service-url').value=url.origin;
                serviceStatus('已填入酒馆电脑地址，请核对模型所在电脑、填写密钥并保存。');break;
            }
            case 'save-connection': {
                try{
                    const next={serviceUrl:root.querySelector('.br-service-url').value.trim(),serviceKey:root.querySelector('.br-service-key').value.trim()};
                    connection(next);Object.assign(config,next);save();onDisable();onEnable();
                    document.querySelector('#br-settings [data-action="open"]').click();
                    document.querySelector('#breeze-reader .br-advanced').open=true;
                }catch(error){serviceStatus(error.message,true);}break;
            }
            case 'discover-voices': refreshVoices();break;
            case 'add-speaker': {
                const input=root.querySelector('.br-new-speaker'),name=input.value.trim(),key=name.toLowerCase();
                if(!name){status('请输入与正文识别结果一致的人物名。',true);break;}
                const p=editProfile();p.names??={};
                if(!Object.hasOwn(p.voices,key))Object.defineProperty(p.voices,key,{value:'',writable:true,enumerable:true,configurable:true});
                Object.defineProperty(p.names,key,{value:name,writable:true,enumerable:true,configurable:true});
                input.value='';save();renderCasting();status(`已添加 ${name}，请选择对应音色。`);break;
            }
            case 'remove-speaker': {
                stop('');const p=editProfile(),key=button.dataset.speakerKey;delete p.voices[key];if(p.names)delete p.names[key];
                save();if(lastReport)renderPreview(lastReport);else renderCasting();status('已清除该人物的配音绑定，朗读时跟随默认声音。');break;
            }
            case 'pregenerate': if(previewId!==null)prepare(previewId);else status('请先识别一条消息。');break;
            case 'cancel-background': cancelBackground();status('已取消预生成。');break;
            case 'cache-refresh': cacheStats();break;
            case 'cache-chat': case 'cache-all': {
                stop('');cache.clear(button.dataset.action==='cache-chat'?owner():undefined).then(()=>{cacheStats();status('轻声音频缓存已清理。');});break;
            }
            case 'save-labels':
                for(const input of root.querySelectorAll('[data-voice-label]'))Object.defineProperty(config.voiceLabels,input.dataset.voiceLabel,{value:input.value.trim(),writable:true,enumerable:true,configurable:true});
                save();sync();status('音色备注已保存，不影响实际音色和已有缓存。');break;
            case 'sentence': case 'from-here':
                if (previewId !== null) readMessage(previewId,{start:Number(button.dataset.index),single:button.dataset.action === 'sentence',toggle:false});
                break;
            case 'preview-latest': { const id = latestId(); if (id < 0) { open(); clearPreview(); status('当前聊天还没有 AI 回复。'); } else preview(id); break; }
            case 'refresh-preview': if (previewId !== null) bindPreview(previewId); break;
            case 'latest': { const id = latestId(); if (id < 0) status('当前聊天还没有 AI 回复。'); else readMessage(id); break; }

        }
    }
    for (const target of [root,bar,settings]) listen(target,'click',action);
    for (const select of [root.querySelector('.br-voice'),bar.querySelector('.br-voice')]) listen(select,'change',()=>{
        stop(''); if (character() || context().groupId) editProfile().defaultVoice = select.value; else config.voice = select.value;
        save(); sync(); if (lastReport) renderPreview(lastReport); status(`已选择 ${voiceName(select.value)}`);
    });
    listen(root.querySelector('.br-casting'),'change',event=>{
        const target = event.target; if (!target.matches('.br-reading-mode,.br-narrator,.br-thought,[data-speaker]')) return;
        stop(''); const p = editProfile();
        if(target.matches('.br-reading-mode'))p.mode=target.value==='single'?'single':'multi';
        else if (target.matches('.br-narrator')) p.narrator = target.value;
        else if (target.matches('.br-thought')) p.thought = target.value;
        else Object.defineProperty(p.voices,target.dataset.speaker,{value:target.value,writable:true,enumerable:true,configurable:true});
        save(); if (lastReport) renderPreview(lastReport);else renderCasting(); status('配音已自动保存到当前角色卡的轻声方案。');
    });
    listen(root.querySelector('.br-auto'),'change',event=>{cancelBackground();config.autoMode=event.target.value;config.auto=config.autoMode==='play';save();});
    listen(root.querySelector('.br-cache-enabled'),'change',event=>{stop('');config.cacheEnabled=event.target.checked;save();status(config.cacheEnabled?'音频缓存已开启。':'音频缓存已关闭，已有缓存保留，可手动清理。');});
    listen(root.querySelector('.br-content-interactions'),'change',event=>{config.contentInteractions=event.target.checked;contentInteraction.hide();root.querySelector('.br-click-read').disabled=!config.contentInteractions;root.querySelector('.br-point-read').disabled=!config.contentInteractions;save();status(config.contentInteractions?'正文快捷朗读已开启。':'正文快捷朗读已关闭，原有播放按钮仍可使用。');});
    listen(root.querySelector('.br-click-read'),'change',event=>{config.clickToRead=event.target.checked;contentInteraction.hide();save();status(config.clickToRead?'单击正文会读本句，拖选和双击选字仍正常使用。':'单击朗读已关闭，仍可选字、右键或 Alt 点击。');});
    listen(root.querySelector('.br-dialogue-only'),'change',event=>{config.dialogueOnly=event.target.checked;stop('');save();if(lastReport&&previewId!==null)renderPreview(lastReport);status(config.dialogueOnly?'已切换为只读对白与心声，旁白将跳过。':'已切换为朗读全部正文。');});
    listen(root.querySelector('.br-point-read'),'change',event=>{config.tapToContinue=event.target.checked;contentInteraction.hide();save();status(config.tapToContinue?'点读已开启：点正文从这里连续朗读。':'点读已关闭。');});
    listen(root.querySelector('.br-follow'),'change',event=>{config.follow=event.target.checked;following=config.follow;save();controls();if(following)highlighter.reveal();});
    listen(root.querySelector('.br-rate'),'input',event=>{config.rate=Number(event.target.value);root.querySelector('.br-rate-value').textContent=`${config.rate.toFixed(2)}×`;if(player.state.active){stop('已保存速度，重新播放时生效。');}save();});
    listen(panel,'close',()=>{if(!panel.open){stopPreview?.();stopPreview=undefined;}});
    listen(document,'click',event=>{
        const button=event.target.closest('.br-preview-message,.br-message');if(!button)return;
        event.preventDefault();event.stopPropagation();const id=Number(button.closest('.mes').getAttribute('mesid'));
        if(button.matches('.br-preview-message'))preview(id);else readMessage(id);
    });
    subscribe('APP_READY',attach);subscribe('CHARACTER_MESSAGE_RENDERED',decorate);subscribe('MORE_MESSAGES_LOADED',decorate);
    subscribe('CHAT_CHANGED',()=>{generating=false;pendingId=null;stop('准备好了');clearPreview();sync();decorate();});
    subscribe('MESSAGE_DELETED',()=>{stop();clearPreview();decorate();});subscribe('MESSAGE_EDITED',()=>stop());subscribe('MESSAGE_SWIPED',()=>stop());
    subscribe('GENERATION_STARTED',(type,options,dryRun)=>{if(dryRun===true)return;cancelBackground();generating=true;pendingId=null;});
    subscribe('MESSAGE_RECEIVED',(id,type)=>{if(generating&&type!=='first_message')pendingId=Number(id);});
    subscribe('GENERATION_STOPPED',()=>{cancelBackground();generating=false;pendingId=null;});
    subscribe('GENERATION_ENDED',()=>{const id=pendingId;generating=false;pendingId=null;decorate();if(!disposed&&config.autoMode!=='manual'&&id!==null)processNewReply(id);});
    contentInteraction=createContentInteractions({
        document,enabled:()=>config.contentInteractions,clickToRead:()=>config.clickToRead,pointToRead:()=>!!config.tapToContinue,
        allowed(id){const message=context().chat[id];return !!message&&!message.is_user&&!message.is_system;},
        onRead:readContent,onStop:()=>stop(),onError:message=>status(message,true),
    });
    cleanup.push(()=>contentInteraction.dispose());
    sync();attach();save();refreshVoices();
    attachIOSReader({root,bar,panel,context,cleanup,cache,owner,config,readMessage,showPoint:item=>highlighter.show(item,false)});
    runtime={dispose(){disposed=true;stop('');cache.close();clearPreview();for(const remove of cleanup)remove();panel.close();root.remove();bar.remove();settings.remove();document.querySelectorAll('.br-message,.br-preview-message').forEach(button=>button.remove());}};
}
export function onDisable(){runtime?.dispose();runtime=undefined;}
onEnable();
