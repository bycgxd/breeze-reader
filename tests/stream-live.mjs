const result=document.querySelector('#results'),nativeFetch=window.fetch.bind(window);
let firstChunkAt,lastChunkAt,endAt,firstEndAt,scheduledAt,audioStarts=0,bytes=0,requests=0;
const nativeStart=AudioBufferSourceNode.prototype.start;
AudioBufferSourceNode.prototype.start=function(...args){scheduledAt??=performance.now();audioStarts++;return nativeStart.apply(this,args);};
window.fetch=async(url,options)=>{
    const target=String(url).replace('http://127.0.0.1:8789','http://127.0.0.1:8790');
    const response=await nativeFetch(target,options);
    if(!target.endsWith('/speech')||!response.ok)return response;
    const number=++requests;
    const reader=response.body.getReader();
    return new Response(new ReadableStream({async pull(controller){try{const next=await reader.read();if(next.done){endAt=performance.now();if(number===1)firstEndAt=endAt;controller.close();}else{firstChunkAt??=performance.now();lastChunkAt=performance.now();bytes+=next.value.length;controller.enqueue(next.value);}}catch(error){controller.error(error);}},cancel(){return reader.cancel();}}),{status:response.status,headers:response.headers});
};
const settings={breeze_reader:{voice:'轩轩',cacheEnabled:true,cacheNamespace:'stream-live-'+Date.now()}};
const ctx={extensionSettings:settings,chatId:'neutral-stream',characterId:0,characters:[{name:'中性样例',avatar:'stream-neutral.png'}],chat:[{is_user:false}],saveSettingsDebounced(){},getRequestHeaders(){return {'Content-Type':'application/json'};},eventTypes:{},eventSource:{on(){},removeListener(){}}};
window.SillyTavern={getContext:()=>ctx};await import('../index.js');
result.textContent='已准备：点击开始，验证真实生成结束前已安排 PCM 播放。';
document.querySelector('#start').onclick=()=>{
    firstChunkAt=lastChunkAt=endAt=firstEndAt=scheduledAt=undefined;audioStarts=bytes=requests=0;
    document.querySelector('.br-message').click();
    const poll=setInterval(()=>{
        const status=document.querySelector('.br-status').textContent;
        result.textContent=JSON.stringify({status,requests,bytes,audioStarts,firstChunkAt,scheduledAt,firstEndAt,endAt,scheduledBeforeFirstResponseEnd:scheduledAt!==undefined&&firstEndAt!==undefined&&scheduledAt<firstEndAt},null,2);
        if(status.includes('朗读完成')||status.includes('已停止')||document.querySelector('.br-status').classList.contains('br-error'))clearInterval(poll);
    },100);
};
