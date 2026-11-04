import {installFakePcm} from './fake-pcm.mjs';
import { collectRenderedMessage, makeSentences } from '../rendered.mjs';
import { createSentenceHighlighter } from '../highlight.mjs';
const results=document.querySelector('#test-results'), checks=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function assert(value,label){if(!value)throw new Error(label);checks.push('✓ '+label);}
async function until(fn){const end=Date.now()+6000;while(!fn()){if(Date.now()>end)throw new Error('等待结果超时：'+document.querySelector('.br-status')?.textContent);await sleep(20);}}
function choose(select,value){select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));}
function click(selector){document.querySelector(selector).click();}
function selected(){return document.querySelector('.br-preview-list [aria-current="true"]')?.dataset.sentence;}
const registry=doc=>doc.defaultView.CSS?.highlights?.get('br-reader-active');
const callbacks=new Map();
const emit=(type,...args)=>{for(const fn of callbacks.get(type)||[])fn(...args);};
try{
    const chat=document.querySelector('#chat');
    const main=document.createElement('div');main.className='mes';main.setAttribute('mesid','0');
    main.innerHTML=`<div class="mes_buttons"></div><div class="mes_text"><xmp id="dcSource" hidden>RAW_MUST_NOT_READ</xmp><div id="dcRoot">
      <div class="dc-narration-block"><p>早上好。窗外晴天。</p></div>
      <div class="dc-msg" data-name="小夏" data-thought="0"><div class="dc-msg-header"><span class="dc-msg-name">小夏</span><span class="dc-msg-mood">开心</span></div><span class="dc-msg-text-content"><em>你好</em><code>跳过这段代码</code>。你好。</span></div>
      <div class="dc-msg" data-name="小夏" data-thought="0"><span class="dc-msg-name">小夏</span><span class="dc-msg-text-content">你好。你好。</span></div>
      <div class="dc-msg" data-name="小冬" data-thought="0"><div class="dc-msg-header"><span class="dc-msg-name">小冬</span><span class="dc-msg-mood">期待</span></div><span class="dc-msg-text-content">我们出发吧！</span></div>
      <div class="dc-msg" data-name="小夏" data-thought="1"><span class="dc-msg-name">小夏</span><span class="dc-msg-mood">平静</span><span class="dc-msg-text-content">（记得带伞。别迟到。）</span></div>
    </div></div>`;chat.append(main);
    const framed=document.createElement('div');framed.className='mes';framed.setAttribute('mesid','1');framed.innerHTML='<div class="mes_buttons"></div><div class="mes_text"></div>';chat.append(framed);
    const frame=document.createElement('iframe');const loaded=new Promise(resolve=>frame.addEventListener('load',resolve,{once:true}));frame.srcdoc='<div id="dcRoot"><div class="dc-narration-block"><p>树叶轻轻摇动。远处传来鸟鸣。</p></div></div>';framed.querySelector('.mes_text').append(frame);await loaded;
    const original=main.innerHTML;
    const sentences=makeSentences(collectRenderedMessage(main).blocks);
    assert(sentences.length===6,'旁白逐句、台词按完整气泡生成六个朗读单元');
    assert(sentences[2].text==='你好。你好。'&&sentences[3].text==='你好。你好。'&&sentences[2].id!==sentences[3].id,'重复台词拥有独立句子标识');
    assert(sentences[2].ranges.map(range=>range.toString()).join('')==='你好。你好。','跨富文本建立文字范围，排除代码节点');
    assert(sentences[2].ranges[0].startContainer!==sentences[3].ranges[0].startContainer,'相同文字定位到各自的实际节点');
    const highlighter=createSentenceHighlighter();
    highlighter.show(sentences[2]);
    assert(main.innerHTML===original&&!!registry(document),'原正文不拆节点，CSS 文字高亮已建立');
    highlighter.clear();assert(!registry(document)&&!document.querySelector('[data-br-owned]'),'清除高亮后没有样式和注册项残留');
    const frameSentence=makeSentences(collectRenderedMessage(framed).blocks)[0];
    highlighter.show(frameSentence);assert(!!registry(frame.contentDocument),'高亮注册在原文字所属 iframe');highlighter.clear();
    assert(highlighter.show({...sentences[2],ranges:[]})==='block'&&document.querySelector('[data-br-owned="highlight"]'),'无文字范围时降级为独立块高亮层');highlighter.clear();
    assert(main.innerHTML===original&&!document.querySelector('[data-br-owned]'),'降级高亮也可无损清理');
    const scroller=document.createElement('div');scroller.style.cssText='height:100px;overflow-y:auto;';
    const paragraph=document.createElement('p');paragraph.style.cssText='margin:0;white-space:pre-line;line-height:22px;';paragraph.textContent=Array.from({length:50},(_,i)=>`第${i+1}句。`).join('\n');scroller.append(paragraph);document.body.append(scroller);
    const lastSentence=makeSentences([{index:0,kind:'narration',element:paragraph,content:paragraph}]).at(-1);highlighter.show(lastSentence,true);
    const sentenceRect=lastSentence.ranges[0].getBoundingClientRect(),scrollRect=scroller.getBoundingClientRect();
    assert(sentenceRect.top>=scrollRect.top&&sentenceRect.bottom<=scrollRect.bottom,'长段落跟随精确到当前句，正确滚动内层容器');highlighter.clear();scroller.remove();

    const harness=installFakePcm({duration:.25}),requests=harness.requests;
    const native={enabled:true,keep:1},foreign={keep:1};
    const settings={tts:native,foreign,breeze_reader:{cacheEnabled:false,voices:['xuanxuan','lilida'],voice:'xuanxuan',profiles:{'neutral.png':{narrator:'lilida',voices:{'小夏':'xuanxuan','小冬':'lilida'}}},bufferMode:'smooth',streamEnabled:false}};
    const protectedSettings=JSON.stringify({native,foreign});
    const ctx={extensionSettings:settings,chatId:'casting-test',characterId:0,characters:[{name:'测试角色',avatar:'neutral.png'},{name:'测试角色',avatar:'another.png'}],chat:[{is_user:false},{is_user:false}],saveSettingsDebounced(){},getRequestHeaders(){return {};},eventTypes:{},eventSource:{on(type,fn){if(!callbacks.has(type))callbacks.set(type,new Set());callbacks.get(type).add(fn);},removeListener(type,fn){callbacks.get(type)?.delete(fn);}}};
    for(const type of ['APP_READY','CHARACTER_MESSAGE_RENDERED','MORE_MESSAGES_LOADED','CHAT_CHANGED','MESSAGE_DELETED','MESSAGE_EDITED','MESSAGE_SWIPED','GENERATION_STARTED','MESSAGE_RECEIVED','GENERATION_STOPPED','GENERATION_ENDED'])ctx.eventTypes[type]=type;
    window.SillyTavern={getContext:()=>ctx};const plugin=await import('../index.js');
    await until(()=>document.querySelector('.br-discovery').textContent.includes('已获取'));
    click('.br-preview-message');
    assert(!document.querySelector('.br-buffer-mode,.br-stream,audio'),'旧分段模式与切换入口已移除，仅保留 PCM 播放');
    assert(!('bufferMode' in settings.breeze_reader)&&!('streamEnabled' in settings.breeze_reader),'旧模式设置被清理');
    assert(document.querySelector('.br-casting').open&&document.querySelector('.br-reading-mode').value==='multi','多角色设置默认展开，旧配音继承为多角色模式');
    assert(document.querySelectorAll('[data-speaker]').length===2,'从渲染正文自动列出两个人物');
    click('.br-message');await until(()=>!!registry(document));assert(selected()==='0','按实际音频播放位置高亮首句');
    await until(()=>document.querySelector('.br-status').textContent.includes('朗读完成'));
    assert(requests.map(r=>r.voice).join(',')==='lilida,lilida,xuanxuan,xuanxuan,lilida,xuanxuan','旁白、两个人物和心理活动按自定义音色顺序朗读');
    assert(requests[2].input==='你好。你好。'&&requests[5].input==='（记得带伞。别迟到。）','多句台词及心理活动完整合成，不在句号处重启语气');
    assert(!registry(document),'完成后清除高亮');
    const sentenceButton=index=>document.querySelector(`.br-preview-list [data-action="sentence"][data-index="${index}"]`);
    sentenceButton(2).click();await until(()=>selected()==='2');const firstRange=[...registry(document)][0];
    assert(firstRange.startContainer===sentences[2].ranges[0].startContainer,'重复台词高亮指向当前句实际文字位置');
    click('#breeze-reader [data-action="pause"]');await sleep(100);assert(document.querySelector('.br-status').textContent.includes('已暂停')&&selected()==='2','流式暂停保留当前位置与高亮');
    click('#breeze-reader [data-action="pause"]');await until(()=>document.querySelector('.br-status').textContent.includes('朗读完成'));
    document.querySelector('.br-new-speaker').value='远方访客';click('[data-action="add-speaker"]');
    choose(document.querySelector('[data-speaker="远方访客"]'),'lilida');assert(settings.breeze_reader.profiles['neutral.png'].voices['远方访客']==='lilida','可提前添加未出现人物并指定音色');
    click('[data-action="refresh-preview"]');assert(!!document.querySelector('[data-speaker="远方访客"]'),'当前消息未出现的已保存人物绑定仍可编辑');
    choose(document.querySelector('.br-narrator'),'xuanxuan');choose(document.querySelector('.br-thought'),'lilida');
    let stamp=requests.length;sentenceButton(5).click();await until(()=>document.querySelector('.br-status').textContent.includes('朗读完成'));
    assert(requests[stamp].voice==='lilida','心理活动可指定独立声音');
    choose(document.querySelector('.br-reading-mode'),'single');assert(document.querySelector('.br-narrator').disabled&&document.querySelector('[data-speaker="小夏"]').disabled,'统一音色模式明确禁用人物分声选择');
    stamp=requests.length;click('.br-message');await until(()=>document.querySelector('.br-status').textContent.includes('朗读完成'));
    assert(requests.slice(stamp).length===6&&requests.slice(stamp).every(r=>r.voice==='xuanxuan'),'统一音色模式覆盖对白、旁白与心理活动');
    choose(document.querySelector('.br-reading-mode'),'multi');assert(document.querySelector('.br-thought').value==='lilida'&&document.querySelector('[data-speaker="小冬"]').value==='lilida','切回多角色保留既有配音设置');
    click('[data-action="remove-speaker"][data-speaker-key="远方访客"]');assert(!document.querySelector('[data-speaker="远方访客"]'),'可清除自定义人物的音色绑定');
    ctx.characterId=1;emit('CHAT_CHANGED');assert(document.querySelector('.br-thought').value==='','同名不同角色卡不共享配音设置');
    ctx.characterId=0;emit('CHAT_CHANGED');click('.br-preview-message');assert(document.querySelector('.br-thought').value==='lilida','切回原角色卡恢复已保存配音');
    harness.failText='我们出发吧！';sentenceButton(4).click();await until(()=>!document.querySelector('#breeze-reader [data-action="retry"]').hidden);assert(!registry(document),'生成失败不错误高亮为播放');
    click('#breeze-reader [data-action="retry"]');await until(()=>document.querySelector('.br-status').textContent.includes('朗读完成'));assert(true,'流式失败后可以重试当前句');
    harness.held=true;stamp=requests.length;sentenceButton(0).click();await until(()=>requests.length>stamp);click('#breeze-reader [data-action="stop"]');const scheduled=harness.scheduled.length;harness.release();await sleep(100);assert(harness.scheduled.length===scheduled&&!registry(document),'停止后迟到数据不会安排旧音频或高亮');
    sentenceButton(0).click();await until(()=>!!registry(document));main.querySelector('.dc-narration-block p').textContent='正文已变化。';await until(()=>document.querySelector('.br-status').textContent.includes('正文已变化'));assert(!registry(document),'正文变化取消旧的流式任务');main.querySelector('.dc-narration-block p').textContent='早上好。窗外晴天。';
    assert(JSON.stringify({native,foreign})===protectedSettings,'多角色设置不改内置 TTS 或其他扩展');
    plugin.onDisable();assert(main.innerHTML===original,'停用后原消息 DOM 完全保留');assert([...callbacks.values()].every(s=>s.size===0),'停用后清理酒馆事件监听');
    plugin.onEnable();click('.br-preview-message');assert(document.querySelector('.br-thought').value==='lilida','重新启用后配音方案仍存在');plugin.onDisable();
    results.textContent=`全部通过：${checks.length} 项\n`+checks.join('\n');
    const demo=document.querySelector('#show-demo');demo.hidden=false;demo.onclick=()=>{plugin.onEnable();click('.br-preview-message');document.querySelector('.br-preview').open=false;};
}catch(error){results.textContent='检查失败：'+error.stack+'\n'+checks.join('\n');throw error;}

