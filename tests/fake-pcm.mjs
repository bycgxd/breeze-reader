export function installFakePcm({duration=.12}={}) {
    const state={requests:[],scheduled:[],held:false,pending:[],failText:''};
    class FakeContext {
        constructor(){this.elapsed=0;this.started=performance.now();this.running=false;this.timers=new Set();this.destination={};}
        get currentTime(){return this.elapsed+(this.running?(performance.now()-this.started)/1000:0);}
        async resume(){if(!this.running){this.started=performance.now();this.running=true;}}
        async suspend(){this.elapsed=this.currentTime;this.running=false;}
        async close(){await this.suspend();for(const timer of this.timers)clearTimeout(timer);this.timers.clear();}
        createBuffer(ch,length,rate){return {duration:length/rate,copyToChannel(){}};}
        createBufferSource(){const context=this;return {playbackRate:{value:1},connect(){},start(time){state.scheduled.push({time,duration:this.buffer.duration/this.playbackRate.value,context});const timer=setTimeout(()=>{context.timers.delete(timer);this.onended?.();},Math.max(0,(time-context.currentTime+this.buffer.duration/this.playbackRate.value)*1000));context.timers.add(timer);},stop(){}};}
    }
    window.AudioContext=FakeContext;
    const response=()=>new Response(new Uint8Array(Math.round(duration*24000)*2),{headers:{'Content-Type':'audio/pcm'}});
    state.release=()=>{state.held=false;state.pending.splice(0).forEach(fn=>fn());};
    window.fetch=async(url,options={})=>{
        if(String(url).endsWith('/health'))return Response.json({status:'ok',bridge:'breeze-reader-3',token:'test-token',voiceDirectory:'中性测试音色库'});
        if(String(url).endsWith('/start')){state.startRequests=(state.startRequests||0)+1;return Response.json({starting:true},{status:202});}
        if(String(url).endsWith('/status'))return Response.json({modelReady:true,starting:false,exitCode:0});
        if(String(url).endsWith('/voices'))return Response.json({voices:['xuanxuan','lilida'].map(id=>({id,loaded:true,revision:'test'}))});
        if(!String(url).endsWith('/speech'))throw Error('Unexpected request: '+url);
        const body=JSON.parse(options.body);state.requests.push(body);
        if(body.input===state.failText){state.failText='';return new Response('模拟模型失败',{status:503});}
        if(state.held)await new Promise((resolve,reject)=>{
            const abort=()=>reject(new DOMException('Aborted','AbortError'));
            options.signal.addEventListener('abort',abort,{once:true});
            state.pending.push(()=>{options.signal.removeEventListener('abort',abort);resolve();});
            if(options.signal.aborted)abort();
        });
        options.signal?.throwIfAborted();return response();
    };
    return state;
}
