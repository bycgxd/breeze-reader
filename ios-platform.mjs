// Platform interface only. The original reader still owns text, voices, settings,
// cache identity, cancellation and source validation. Other browsers never enter it.
let currentPlayer, registration, controls;
const uuid=()=>{const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=[...bytes].map(v=>v.toString(16).padStart(2,'0')).join('');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');};
export const isIOSReader=()=>!!bridge();
export function pointIOSReader(item){currentPlayer?.markPoint?.(item);}
const bridge=()=>globalThis.__nativeIOSReader?.version===1?globalThis.__nativeIOSReader:null;
const encode=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
const decode=value=>Uint8Array.from(atob(value),v=>v.charCodeAt(0));
export function createIOSPlayer(options){
    if(!bridge()||!options.ios)return null;
    let revision=0,planID=null,nextPlanID=null,disposed=false,livePlan=null,pointIndex=null;
    let state={items:[],index:-1,part:1,messageId:null,single:false,phase:'idle',active:false,paused:false,error:'',buffered:0};
    const emit=()=>{options.onState({...state});controls?.publish();};
    function stopLocal(reason="restart"){pointIndex=null;revision++;const old=planID??nextPlanID;planID=null;nextPlanID=null;if(old){const handoff=bridge()?.cacheHandoff===true&&['restart','handoff'].includes(reason);nextPlanID=handoff?uuid():null;bridge()?.post('cancel',{id:old,reason:handoff?'handoff':reason,nextID:nextPlanID,registration,context:controls?.identity()}).catch(()=>{});}options.clearHighlight();livePlan=null;state.active=false;state.paused=false;}
    async function start(items,settings={}){
        const reserved=nextPlanID;nextPlanID=null;stopLocal();const ticket=revision;planID=reserved??nextPlanID??uuid();nextPlanID=null;
        state={...state,items,index:settings.start??0,messageId:settings.messageId??null,single:!!settings.single,phase:'buffering',active:true,paused:false,error:'',buffered:0};emit();
        if(!items[state.index]){state.active=false;state.phase='idle';emit();return;}
        const id=planID;let stage="prepare";
        try{
            if(items.some(item=>!options.valid(item)))throw Error('正文已变化，请重新识别后播放。');
            const plan=await options.ios.prepare(items,{...settings,start:state.index});
            if(ticket!==revision||disposed)return;
            livePlan=plan;last=-1;
            stage='begin';
            const reply=await bridge().post('begin',{...plan,id,registration,rate:Math.max(.6,Math.min(1.6,options.rate())),start:state.index,single:state.single,messageId:state.messageId});
            const retained=bridge()?.cacheHandoff===true&&Array.isArray(reply?.cachedKeys)?reply.cachedKeys:[];
            let uploadedBytes=retained.length?Math.max(0,Math.min(100*1024*1024,Number(reply.cachedBytes)||0)):0;const uploaded=new Set(retained);
            for(const item of plan.items)for(const segment of item.segments){
                if(uploaded.has(segment.key))continue;
                if(ticket!==revision)return;
                stage="cached-read";
                const blob=await options.ios.cached(segment.key,plan);if(!blob||blob.size>100*1024*1024-uploadedBytes)continue;
                let bytes;
                try{bytes=new Uint8Array(await blob.arrayBuffer());}
                catch(error){if(error.name==='NotFoundError'){options.ios.unreadable?.();continue;}throw error;}
                uploaded.add(segment.key);uploadedBytes+=bytes.length;
                for(let offset=0;offset<bytes.length;offset+=147456){
                    if(ticket!==revision)return;
                    stage='cached-upload';
                    await bridge().post('cached',{id,key:segment.key,offset,data:encode(bytes.subarray(offset,offset+147456)),last:offset+147456>=bytes.length});
                }
            }
            if(ticket!==revision)return;
            stage='commit';
            await bridge().post('commit',{id});
        }catch(error){if(ticket!==revision||disposed)return;options.clearHighlight();state.active=false;state.paused=false;state.phase='error';state.error=/[\u3400-\u9fff]/.test(error.message||'')?error.message:'朗读准备失败，请检查连接或清理音频缓存后重试。';emit();bridge()?.post('failure',{id,registration,message:state.error,code:(stage+':'+(error.name||'error')).toLowerCase().replace(/[^a-z0-9:-]/g,'').slice(0,64)}).catch(()=>{});}
    }
    const command=action=>planID?bridge().post('control',{id:planID,action}).catch(error=>{state.error=error.message;state.phase='error';emit();}):Promise.resolve();
    let last=-1;const chunks=new Map();
    const api={markPoint(item){if(!state.active)return;pointIndex=state.items.findIndex(v=>v.id===item?.id&&v.element===item?.element);if(pointIndex>=0)controls?.point?.(state.items[pointIndex]);},get state(){return {...state};},start,
      stop(reason="original-stop"){stopLocal(reason);state={...state,items:[],index:-1,messageId:null,phase:'idle',error:''};last=-1;chunks.clear();selectionActions.clear();emit();},
      pause(){return command('pause');},resume(){return command('resume');},previous(){return command('previous');},next(){return command('next');},retry(){return start(state.items,{start:state.index,messageId:state.messageId,single:state.single});},
      receive(value){if(value.id!==planID||disposed)return;const item=state.items[value.index];
        if(item&&!options.valid(item)){api.stop("invalid-source");return;}
        state={...state,index:value.index,phase:value.phase,paused:value.paused,active:value.active,error:value.error||'',buffered:value.buffered||0};
        if(value.phase==='idle'){state.items=[];state.messageId=null;planID=null;livePlan=null;last=-1;selectionActions.clear();}
        if(value.phase==='buffering'){options.clearHighlight();last=-1;if(pointIndex===value.index)controls?.point?.(item);}
        if(value.phase==='playing'&&item&&last!==value.index){pointIndex=null;last=value.index;options.onStart(item,{...state});}
        if(!state.active)options.clearHighlight();emit();},
      async cache(value){if(value.id!==planID||disposed)return false;let part=chunks.get(value.key);if(value.offset===0){part=[];chunks.set(value.key,part);}if(!part)throw Error('cache_chunk_order');
        part.push(decode(value.data));if(value.last){chunks.delete(value.key);await options.ios.store(value.key,new Blob(part,{type:'audio/wav'}),livePlan);}return true;},
      dispose(){api.stop("dispose");disposed=true;if(currentPlayer===api)currentPlayer=null;}
    };currentPlayer=api;return api;
}

export function attachIOSReader({root,bar,panel,context,cleanup,cache,owner,config,readMessage,showPoint}){
    const host=bridge();if(!host||!currentPlayer)return;
    registration=uuid();host.registration=registration;let serial=0,disposed=false,publishQueued=false;
    const nodeIDs=new WeakMap(),nodeID=node=>{if(!nodeIDs.has(node))nodeIDs.set(node,String(++serial));return nodeIDs.get(node);};
    const fields=new Map(),actions=new Map();let contextID='';
    const selector={mode:'.br-reading-mode',voice:'.br-voice',narrator:'.br-narrator',thought:'.br-thought',rate:'.br-rate',follow:'.br-follow',auto:'.br-auto',cache:'.br-cache-enabled',interactions:'.br-content-interactions',clickRead:'.br-click-read',pointRead:'.br-point-read',dialogueOnly:'.br-dialogue-only',serviceUrl:'.br-service-url',serviceKey:'.br-service-key',newSpeaker:'.br-new-speaker',testText:'.br-test-text'};
    function snapshot(){
        const c=context(),identity=JSON.stringify([c.characterId,c.groupId,c.chatId??c.getCurrentChatId?.()]);
        if(contextID&&contextID!==identity){hideIOSSelection();selectionActions.clear();}
        contextID=identity;fields.clear();actions.clear();const result=[];
        function field(key,node,label,section){if(!node)return;const id=nodeID(node);fields.set(id,{node,identity});result.push({id,key,label,section,type:node.tagName==='SELECT'?'select':node.type==='checkbox'?'toggle':node.type==='range'?'rate':node.type==='password'?'secret':'text',value:node.type==='checkbox'?String(node.checked):node.value,disabled:node.disabled===true,options:[...(node.options||[])].map(o=>({value:o.value,label:o.textContent,disabled:o.disabled}))});}
        for(const [key,path]of Object.entries(selector))field(key,root.querySelector(path),({mode:'配音模式',voice:'默认声音',narrator:'旁白',thought:'心理活动',rate:'播放速度',follow:'跟随正文滚动',auto:'新回复处理',cache:'音频缓存',interactions:'正文快捷朗读',clickRead:'单击读本句',pointRead:'点读模式',dialogueOnly:'只读角色对白',serviceUrl:'轻声服务地址',serviceKey:'连接密钥',newSpeaker:'人物名称',testText:'试听文本'})[key],['serviceUrl','serviceKey'].includes(key)?'connection':['cache'].includes(key)?'cache':['newSpeaker'].includes(key)?'speakers':['testText'].includes(key)?'test':['mode','voice','narrator','thought','dialogueOnly'].includes(key)?'casting':'preferences');
        for(const node of root.querySelectorAll('[data-speaker]'))field('speaker:'+node.dataset.speaker,node,node.closest('label')?.firstChild?.textContent||node.dataset.speaker,'speakers');
        for(const node of root.querySelectorAll('[data-voice-label]'))field('voiceLabel:'+node.dataset.voiceLabel,node,node.closest('label')?.firstChild?.textContent||'音色备注','labels');
        const buttons=[];
        for(const node of root.querySelectorAll('[data-action]')){
          const action=node.dataset.action;if(['close','pause','previous','next','stop','retry','sentence','from-here','open'].includes(action))continue;
          const id=nodeID(node);actions.set(id,{node,identity});buttons.push({id,action,label:(node.getAttribute('aria-label')||node.textContent).trim(),disabled:node.disabled||node.hidden});
        }
        const sentences=[...root.querySelectorAll('.br-preview-list li')].map(node=>{const read=node.querySelector('[data-action="sentence"]'),from=node.querySelector('[data-action="from-here"]');const ids=[];for(const b of [read,from]){const id=nodeID(b);actions.set(id,{node:b,identity});ids.push(id);}return {index:Number(node.dataset.sentence),text:node.querySelector('p')?.textContent||'',detail:node.querySelector('.br-preview-meta')?.textContent||'',read:ids[0],from:ids[1]};});
        return {registration,context:identity,fields:result,buttons,sentences,status:root.querySelector('.br-status')?.textContent||'',serviceStatus:root.querySelector('.br-service-status')?.textContent||'',discovery:root.querySelector('.br-discovery')?.textContent||'',cacheStatus:root.querySelector('.br-cache-stats')?.textContent||'',cacheNotice:root.querySelector('.br-cache-notice')?.textContent||'',character:root.querySelector('.br-character')?.textContent||'',conflict:!root.querySelector('.br-conflict')?.hidden,preview:root.querySelector('.br-preview-summary')?.textContent||''};
    }
    function publish(){if(disposed||publishQueued)return;publishQueued=true;queueMicrotask(()=>{publishQueued=false;if(!disposed)host.post('ui',snapshot()).catch(()=>{});});}
    function closePanel(){if(panel.open)panel.close();}
    host.receive=value=>currentPlayer?.receive(value);
    host.cache=value=>currentPlayer?.cache(value);
    host.command=async request=>{
        if(disposed||request.registration!==registration)throw Error('reader_expired');
        if(request.context&&request.context!==controls?.identity())throw Error('reader_context_changed');
        const state=currentPlayer.state;
        if(['pause','resume','previous','next','stop','retry'].includes(request.action)){return currentPlayer[request.action]();}
        if(request.action==='replay')return currentPlayer.start(state.items,{start:0,messageId:state.messageId,single:state.single});
        if(request.action==='sentence'){return currentPlayer.start(state.items,{start:request.value,messageId:state.messageId,single:state.single});}
        if(request.action==='selection'){const record=selectionActions.get(request.value?.id);if(!record||record.identity!==controls?.identity())throw Error('selection_expired');selectionActions.delete(request.value.id);if(selectionID===request.value.id){selectionID=null;selectionAction=null;}record.action(request.value.action);if(['selection','sentence','from'].includes(request.value.action)&&!currentPlayer?.state.active)host.post('present',{registration}).catch(()=>{});return;}
        if(request.action==='refresh'){publish();return;}
        if(request.action==='readMessage'){readMessage(Number(request.value),{toggle:false});return;}
        const found=fields.get(request.id)||actions.get(request.id);if(!found||!found.node?.isConnected||found.node.disabled||found.identity!==contextID)throw Error('reader_control_expired');
        const c=context();if(JSON.stringify([c.characterId,c.groupId,c.chatId??c.getCurrentChatId?.()])!==found.identity)throw Error('reader_context_changed');
        if(request.action==='field'){
            const node=found.node;if(node.tagName==='SELECT'&&![...node.options].some(o=>o.value===request.value&&!o.disabled))throw Error('reader_option_expired');
            if(node.type==='checkbox')node.checked=request.value==='true';else node.value=request.value;
            node.dispatchEvent(new Event(node.type==='range'?'input':'change',{bubbles:true}));
        }else if(request.action==='button')found.node.click();
        closePanel();publish();
    };
    const observer=new MutationObserver(records=>{if(records.some(r=>r.type==='attributes'&&r.target===panel&&panel.open)){closePanel();host.post('present',{registration}).catch(()=>{});}publish();});
    observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['open','disabled','hidden']});
    const changed=()=>publish();root.addEventListener('change',changed);root.addEventListener('input',changed);
    document.documentElement.classList.add('native-ios-reader');controls={publish,point:item=>showPoint?.(item),identity:()=>{const c=context();return JSON.stringify([c.characterId,c.groupId,c.chatId??c.getCurrentChatId?.()]);}};publish();
    cleanup.push(()=>{disposed=true;hideIOSSelection();selectionActions.clear();observer.disconnect();root.removeEventListener('change',changed);root.removeEventListener('input',changed);currentPlayer?.dispose();document.documentElement.classList.remove('native-ios-reader');host.post('detach',{registration}).catch(()=>{});controls=null;});
}

let selectionID=null,selectionAction=null;const selectionActions=new Map();
export function presentIOSSelection({selected,count,onAction}){
    const host=bridge();if(!host||!registration)return false;
    selectionID=uuid();selectionAction=onAction;selectionActions.set(selectionID,{action:onAction,identity:controls?.identity()});while(selectionActions.size>8)selectionActions.delete(selectionActions.keys().next().value);
    host.post('selection',{registration,id:selectionID,selected,count}).catch(()=>{});return true;
}
export function hideIOSSelection(){
    const id=selectionID;selectionID=null;selectionAction=null;
    if(id)bridge()?.post('selection-close',{id}).catch(()=>{});
}
