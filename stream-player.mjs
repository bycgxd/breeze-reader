import {createIOSPlayer} from './ios-platform.mjs';
export function createStreamPlayer(options) {
    const native=createIOSPlayer(options);if(native)return native;
    const {generate,onState,onStart,clearHighlight,valid=()=>true,rate=()=>1,createContext=()=>new (globalThis.AudioContext || globalThis.webkitAudioContext)()}=options;
    let state={items:[],index:-1,part:0,messageId:null,single:false,phase:'idle',active:false,paused:false,error:'',buffered:0};
    let controller,context,timer,sources=new Set(),revision=0;
    const emit=phase=>{state.phase=phase;onState({...state});};
    function cancel(){revision++;controller?.abort();controller=undefined;clearInterval(timer);timer=undefined;for(const source of sources){try{source.stop();}catch{}}sources.clear();const old=context;context=undefined;old?.close().catch(()=>{});state.active=false;state.paused=false;clearHighlight();}
    async function start(items,options={}) {
        cancel();state={...state,items,index:options.start??0,part:1,messageId:options.messageId??null,single:!!options.single,error:'',buffered:0,paused:false};
        if(!items[state.index]){emit('idle');return;}
        const token=revision,ctrl=controller=new AbortController();state.active=true;
        let ctx;
        try{ctx=context=createContext();await ctx.resume();}
        catch(error){if(token!==revision)return;cancel();state.error='浏览器未允许音频播放，请点击朗读重试。';emit('error');return;}
        if(token!==revision)return;
        const speed=Math.max(.6,Math.min(1.6,rate())),marks=[],lead=1.2;
        let next=ctx.currentTime,pending=[],pendingSeconds=0,lastMark=-1,done=false,failure,producing=state.index,lastUpdate=0;
        const sleep=()=>new Promise(resolve=>setTimeout(resolve,20));
        function schedule(value){
            const buffer=ctx.createBuffer(1,value.samples.length,24000);buffer.copyToChannel(value.samples,0);
            const source=ctx.createBufferSource();source.buffer=buffer;source.playbackRate.value=speed;source.connect(ctx.destination);
            const when=Math.max(next,ctx.currentTime+.025),duration=buffer.duration/speed;
            marks.push({start:when,end:when+duration,index:value.index});next=when+duration;
            sources.add(source);source.onended=()=>sources.delete(source);source.start(when);
        }
        function flush(){for(const value of pending)schedule(value);pending=[];pendingSeconds=0;}
        timer=setInterval(()=>{
            if(token!==revision)return;
            state.buffered=Math.max(0,next-ctx.currentTime)+pendingSeconds;
            if(state.paused)return;
            let found=-1;
            for(let i=marks.length-1;i>=0;i--)if(ctx.currentTime>=marks[i].start && ctx.currentTime<marks[i].end){found=i;break;}
            if(found>=0){
                const index=marks[found].index;
                if(!valid(items[index])){failure=new Error('正文已变化，请重新识别后播放。');ctrl.abort();return;}
                const changed=lastMark!==index;
                if(changed){lastMark=index;state.index=index;onStart(items[index],{...state});}
                if(changed || state.phase!=='playing')emit('playing');
            }else if(!done && next<=ctx.currentTime){
                if(lastMark!==-1){lastMark=-1;clearHighlight();}
                if(state.phase!=='buffering' || Date.now()-lastUpdate>500){lastUpdate=Date.now();emit('buffering');}
            }
        },30);
        try{
            emit('buffering');
            const end=state.single?state.index+1:items.length,startIndex=state.index;
            for(let index=startIndex;index<end;index++){
                producing=index;
                ctrl.signal.throwIfAborted();if(!valid(items[index]))throw new Error('正文已变化，请重新识别后播放。');
                for await(const samples of generate(items[index],ctrl.signal)){
                    ctrl.signal.throwIfAborted();
                    while(next-ctx.currentTime+pendingSeconds>=8){await sleep();ctrl.signal.throwIfAborted();}
                    if(next>ctx.currentTime+.03 && !pending.length)schedule({samples,index});
                    else {pending.push({samples,index});pendingSeconds+=samples.length/24000/speed;if(pendingSeconds>=lead)flush();}
                }
            }
            done=true;flush();
            while(ctx.currentTime<next){await sleep();ctrl.signal.throwIfAborted();}
            if(token!==revision)return;
            cancel();state.index=end-1;emit('finished');
        }catch(error){
            if(token!==revision)return;
            const reason=failure || error;cancel();state.index=producing;state.error=reason.message || String(reason);emit('error');
        }
    }
    const restart=index=>start(state.items,{start:index,messageId:state.messageId,single:state.single});
    return {
        get state(){return {...state};},start,
        stop(){cancel();state={...state,items:[],index:-1,messageId:null,error:''};emit('idle');},
        previous(){if(state.index>0)return restart(state.index-1);},next(){if(state.index+1<state.items.length)return restart(state.index+1);},retry(){return restart(state.index);},
        pause(){if(state.active&&!state.paused){state.paused=true;context.suspend().catch(()=>{});emit('paused');}},
        resume(){if(state.active){state.paused=false;context.resume().then(()=>emit('buffering')).catch(error=>{state.error=error.message;emit('error');});}},
    };
}
