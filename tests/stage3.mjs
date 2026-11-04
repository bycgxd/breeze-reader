import {installFakePcm} from './fake-pcm.mjs';
import {createAudioCache,audioKey} from '../cache.mjs';
const results=document.querySelector('#test-results'),checks=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function assert(ok,label){if(!ok)throw Error(label);checks.push('✓ '+label);}
async function until(fn){const end=Date.now()+8000;while(!fn()){if(Date.now()>end)throw Error('等待超时：'+document.querySelector('.br-status')?.textContent);await sleep(15);}}
const click=selector=>document.querySelector(selector).click();
function choose(selector,value){const e=document.querySelector(selector);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}
let plugin,cache,other,persistence;
try{
    const namespace='stage3-'+Date.now();
    cache=createAudioCache(namespace,{limit:8});other=createAudioCache(namespace+'-other');
    await cache.put('a','chat1',new Blob(['1234']));cache.close();
    persistence=createAudioCache(namespace,{limit:8});
    assert(await (await persistence.get('a','chat1')).text()==='1234','关闭并重新打开数据库后音频仍可复用');
    assert((await persistence.stats()).persistent,'实际使用 IndexedDB 持久存储');
    assert(!(await other.get('a','chat1')),'账号命名空间隔离');
    await persistence.get('a','chat2');await persistence.clear('chat1');assert(!!await persistence.get('a','chat2'),'清理聊天保留其他聊天共享音频');
    await persistence.clear('chat2');assert((await persistence.stats()).count===0,'最后一个聊天清理后释放音频');
    await persistence.put('a','chat',new Blob(['1234']));await sleep(10);await persistence.put('b','chat',new Blob(['5678']));await sleep(10);await persistence.get('a','chat');await sleep(10);await persistence.put('c','chat',new Blob(['abcd']));
    assert(!(await persistence.get('b','chat'))&&(await persistence.stats()).bytes===8,'超限按最近访问时间淘汰旧缓存');
    await other.put('keep','chat',new Blob(['keep']));await persistence.clear();assert(!!await other.get('keep','chat'),'一键清理不触碰其他账号缓存');

    const callbacks=new Map(),emit=(type,...args)=>{for(const fn of callbacks.get(type)||[])fn(...args);};
    const settings={tts:{enabled:true,keep:1},foreign:{keep:1},breeze_reader:{cacheNamespace:namespace+'-plugin',voices:['xuanxuan','lilida'],voice:'xuanxuan',cacheEnabled:true}};
    const protectedSettings=JSON.stringify({tts:settings.tts,foreign:settings.foreign});
    const ctx={extensionSettings:settings,chatId:'neutral-chat',characterId:0,characters:[{name:'中性样例',avatar:'stage3.png'}],chat:[{is_user:false}],saveSettingsDebounced(){},getRequestHeaders(){return {'Content-Type':'application/json'};},eventTypes:{},eventSource:{on(type,fn){if(!callbacks.has(type))callbacks.set(type,new Set());callbacks.get(type).add(fn);},removeListener(type,fn){callbacks.get(type)?.delete(fn);}}};
    for(const type of ['APP_READY','CHARACTER_MESSAGE_RENDERED','MORE_MESSAGES_LOADED','CHAT_CHANGED','MESSAGE_DELETED','MESSAGE_EDITED','MESSAGE_SWIPED','GENERATION_STARTED','MESSAGE_RECEIVED','GENERATION_STOPPED','GENERATION_ENDED'])ctx.eventTypes[type]=type;
    document.querySelector('#chat').innerHTML='<div class="mes" mesid="0"><div class="mes_buttons"></div><div class="mes_text"><div id="dcRoot"><div class="dc-narration-block"><p>清晨到了。阳光很好。</p></div><div class="dc-msg" data-name="小夏" data-thought="0"><span class="dc-msg-name">小夏</span><span class="dc-msg-mood">开心</span><span class="dc-msg-text-content">我们出发吧。</span></div></div></div></div>';
    const original=document.querySelector('.mes_text').innerHTML;
    const harness=installFakePcm();
    const requests=()=>harness.requests.length,plays=()=>harness.scheduled.length;
    window.SillyTavern={getContext:()=>ctx};plugin=await import('../index.js');
    click('.br-preview-message');click('[data-action="pregenerate"]');await until(()=>document.querySelector('.br-status').textContent.includes('预生成完成'));
    assert(document.querySelector('.br-cache-stats').textContent.includes('/ 500 MiB'),'缓存面板显示 500 MiB 上限');
    assert(requests()===3&&plays()===0,'预生成按正文顺序合成三句，不播放');
    click('.br-preview-list [data-action="sentence"]');await until(()=>plays()===1);assert(requests()===3,'已预生成句子直接命中缓存，不再次请求模型');
    click('[data-action="stop"]');
    plugin.onDisable();plugin.onEnable();click('.br-preview-message');click('.br-preview-list [data-action="sentence"]');await until(()=>plays()===2);assert(requests()===3,'重新启用插件后仍复用持久缓存');click('[data-action="stop"]');
    const beforeSpeed=requests();choose('.br-rate','1.25');click('.br-preview-list [data-action="sentence"]');await until(()=>plays()===3);assert(requests()===beforeSpeed,'播放倍速变化不重做合成');click('[data-action="stop"]');
    const label=document.querySelector('[data-voice-label="xuanxuan"]');label.value='轩轩';click('[data-action="save-labels"]');assert(document.querySelector('.br-voice option[value="xuanxuan"]').textContent.includes('轩轩'),'音色中文备注保留实际音色名');
    choose('.br-narrator','lilida');click('.br-preview-list [data-action="sentence"]');await until(()=>plays()===4);assert(requests()===beforeSpeed+1,'更换旁白音色只重新生成相关句子');click('[data-action="stop"]');
    assert(!document.querySelector('[data-action="download"]'),'清单仅提供在线播放，不含音频下载入口');
    choose('.br-auto','prepare');const oldRequests=requests();const paragraph=document.querySelector('.dc-narration-block p');
    emit('GENERATION_STARTED');emit('MESSAGE_RECEIVED',0,'normal');emit('GENERATION_ENDED');paragraph.textContent='午后到了。风很轻。';emit('CHARACTER_MESSAGE_RENDERED',0);
    await until(()=>document.querySelector('.br-status').textContent.includes('预生成完成'));
    assert(requests()===oldRequests+2&&plays()===4,'新回复仅预生成等待稳定正文，不播放并复用未改句子');
    choose('.br-auto','play');emit('GENERATION_STARTED');emit('MESSAGE_RECEIVED',0,'normal');emit('GENERATION_ENDED');await until(()=>plays()>4);assert(requests()===oldRequests+2,'新回复自动播放复用已准备缓存');click('[data-action="stop"]');const afterAuto=plays();
    choose('.br-auto','manual');emit('GENERATION_STARTED');emit('MESSAGE_RECEIVED',0,'normal');emit('GENERATION_ENDED');await sleep(800);assert(plays()===afterAuto,'手动模式不触发新回复朗读');
    choose('.br-auto','prepare');emit('GENERATION_STARTED');emit('MESSAGE_RECEIVED',0,'normal');emit('GENERATION_ENDED');click('[data-action="stop"]');await sleep(800);assert(plays()===afterAuto&&!document.querySelector('.br-status').textContent.includes('预生成完成'),'停止会取消等待正文稳定的自动任务');
    click('[data-action="cache-all"]');await until(()=>document.querySelector('.br-status').textContent.includes('缓存已清理'));click('[data-action="cache-refresh"]');await until(()=>document.querySelector('.br-cache-stats').textContent.includes('0 段'));assert(true,'面板显示用量并可清理本账号缓存');
    const beforeStart=requests();click('#br-settings [data-action="start-service"]');
    assert([...document.querySelectorAll('[data-action="start-service"]')].every(button=>button.disabled),'设置和面板都有启动按钮，启动中同步禁用');
    click('#breeze-reader [data-action="start-service"]');await until(()=>document.querySelector('.br-service-status').textContent.includes('轻声已就绪'));
    assert(harness.startRequests===1&&[...document.querySelectorAll('[data-action="start-service"]')].every(button=>!button.disabled),'启动请求不会重复提交，完成后恢复按钮');
    assert(requests()===beforeStart&&document.querySelector('#br-settings .br-service-status').textContent.includes('2 个音色'),'启动完成刷新音色与状态，不自动生成或播放语音');
    document.querySelector('.br-service-url').value='http://192.168.31.178:8790';document.querySelector('.br-service-key').value='test-key';click('[data-action="save-connection"]');
    assert(settings.breeze_reader.serviceUrl==='http://192.168.31.178:8790'&&settings.breeze_reader.serviceKey==='test-key','远程地址和密钥仅保存在轻声设置，保存时重建并取消旧任务');
    click('#br-settings [data-action="start-service"]');await until(()=>document.querySelector('.br-service-status').textContent.includes('轻声已就绪'));
    assert(harness.startRequests===1&&document.querySelector('#br-settings [data-action="start-service"]').textContent==='连接轻声','远程模式只检查连接，不调用本机启动或重复启动服务');
    assert(JSON.stringify({tts:settings.tts,foreign:settings.foreign})===protectedSettings,'未改内置 TTS 或其他扩展设置');
    paragraph.textContent='清晨到了。阳光很好。';plugin.onDisable();assert(document.querySelector('.mes_text').innerHTML===original,'停用后原渲染 DOM 保持原样');assert([...callbacks.values()].every(set=>set.size===0),'停用后无事件监听残留');
    results.textContent=`全部通过：${checks.length} 项\n`+checks.join('\n');
    document.querySelector('.mes_text').innerHTML=original;plugin.onEnable();click('.br-preview-message');document.querySelector('.br-cache').open=true;
}catch(error){results.textContent='检查失败：'+error.stack+'\n'+checks.join('\n');throw error;}
finally{await persistence?.clear();await other?.clear();cache?.close();persistence?.close();other?.close();}
