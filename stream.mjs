import {connection,LOCAL_BRIDGE} from './connection.mjs';
export const BRIDGE = LOCAL_BRIDGE;
export async function bridgeHealth(signal,config) {
    const remote=connection(config);
    let response;
    try{response=await fetch(remote.base+'/health',{headers:remote.headers,signal:signal || AbortSignal.timeout(3000),credentials:'omit'});}
    catch(error){if(signal?.aborted)throw error;throw new Error(`无法连接轻声服务 ${remote.base}，请检查电脑服务、网络和连接地址。`);}
    if(response.status===401)throw new Error('连接密钥不正确，请检查轻声连接设置。');
    if(!response.ok)throw new Error(`轻声接口未就绪（${response.status}），请在模型电脑启动轻声。`);
    const health=await response.json();
    if(health.bridge!=='breeze-reader-3' || !health.token)throw new Error('请重新运行「启动轻声」，更新本机接口后刷新页面。');
    return health;
}
export async function discoverVoices(signal,config) {
    const health=await bridgeHealth(signal,config),remote=connection(config);
    const response=await fetch(remote.base+'/voices',{headers:remote.headers,signal:signal || AbortSignal.timeout(8000),credentials:'omit'});
    if(!response.ok)throw new Error('无法读取音色，请确认本地模型已启动。');
    const result=await response.json();
    if(!Array.isArray(result.voices))throw new Error('音色列表格式错误。');
    return {...health,voices:result.voices.filter(row=>/^[a-zA-Z0-9_-]{1,64}$/.test(row.id)&&typeof (row.name??row.id)==='string')};
}
export async function* readPcm(response) {
    if(!response.ok)throw new Error(`流式请求失败（${response.status}）：${(await response.text()).slice(0,160)}`);
    if(!(response.headers.get('content-type') || '').startsWith('audio/pcm'))throw new Error('接口未返回 PCM 音频。');
    const reader=response.body.getReader();let odd;
    try {
        while(true){
            const {done,value}=await reader.read();if(done)break;
            let bytes=value;
            if(odd!==undefined){bytes=new Uint8Array(value.length+1);bytes[0]=odd;bytes.set(value,1);odd=undefined;}
            if(bytes.length%2){odd=bytes[bytes.length-1];bytes=bytes.subarray(0,-1);}
            if(bytes.length){const samples=new Float32Array(bytes.length/2),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true)/32768;yield samples;}
        }
        if(odd!==undefined)throw new Error('PCM 音频末尾不完整。');
    } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function pcmWav(samples) {
    const total=samples.reduce((n,value)=>n+value.length,0),header=new ArrayBuffer(44),v=new DataView(header);
    for(const [offset,tag]of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])for(let i=0;i<tag.length;i++)v.setUint8(offset+i,tag.charCodeAt(i));
    v.setUint32(4,36+total*2,true);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,24000,true);v.setUint32(28,48000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);v.setUint32(40,total*2,true);
    return new Blob([header,...samples.map(part=>{const bytes=new ArrayBuffer(part.length*2),view=new DataView(bytes);for(let i=0;i<part.length;i++)view.setInt16(i*2,Math.max(-32768,Math.min(32767,Math.round(part[i]*32768))),true);return bytes;})],{type:'audio/wav'});
}
export async function* cachedPcm(blob) {
    const bytes=await blob.arrayBuffer(),v=new DataView(bytes);
    // Only this module's fixed PCM cache format is read here, with a distinct cache key.
    if(bytes.byteLength<44 || (bytes.byteLength-44)%2 || v.getUint32(0,false)!==0x52494646 || v.getUint32(8,false)!==0x57415645 || v.getUint16(20,true)!==1 || v.getUint16(22,true)!==1 || v.getUint32(24,true)!==24000 || v.getUint16(34,true)!==16 || v.getUint32(40,true)!==bytes.byteLength-44)throw new Error('流式缓存格式无效，请清理轻声缓存。');
    const samples=new Float32Array((bytes.byteLength-44)/2);
    for(let i=0;i<samples.length;i++)samples[i]=v.getInt16(44+i*2,true)/32768;
    for(let i=0;i<samples.length;i+=4800)yield samples.subarray(i,i+4800);
}
