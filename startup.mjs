import {bridgeHealth} from './stream.mjs';
import {connection} from './connection.mjs';

export async function startLocalService({signal,onProgress=()=>{},launch=()=>{globalThis.location.href='breeze-reader://start';},timeout=110000,interval=800,config}={}) {
    const remote=connection(config);
    if(!remote.local){
        const active=signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000);
        onProgress('正在连接远程轻声服务…');
        await bridgeHealth(active,config);
        const response=await fetch(remote.base+'/status',{headers:remote.headers,signal:active,credentials:'omit'});
        if(!response.ok||!(await response.json()).modelReady)throw new Error('远程模型尚未就绪，请先在模型所在电脑启动轻声。');
        onProgress('轻声已就绪。');return;
    }
    const controller=new AbortController(),deadline=Date.now()+timeout;
    const timer=setTimeout(()=>controller.abort(new Error('轻声启动未完成，请允许浏览器打开本机启动程序，或手动运行「启动轻声.bat」。')),timeout);
    const active=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const limited=ms=>AbortSignal.any([active,AbortSignal.timeout(ms)]);
    const pause=()=>new Promise((resolve,reject)=>{
        const end=()=>{clearTimeout(wait);active.removeEventListener('abort',abort);resolve();};
        const abort=()=>{clearTimeout(wait);active.removeEventListener('abort',abort);reject(active.reason);};
        const wait=setTimeout(end,interval);active.addEventListener('abort',abort,{once:true});if(active.aborted)abort();
    });
    try {
        let health;
        try{health=await bridgeHealth(limited(900),config);}catch(error){
            active.throwIfAborted();
            onProgress('正在打开本机启动程序；浏览器若询问，请允许打开。');
            launch();
            while(!health&&Date.now()<deadline){
                await pause();
                try{health=await bridgeHealth(limited(2000),config);}catch{active.throwIfAborted();}
            }
        }
        active.throwIfAborted();
        if(!health)throw new Error('无法连接轻声本机接口，请运行「启动轻声.bat」。');
        onProgress('正在准备音色并启动模型，请稍候…');
        const response=await fetch(remote.base+'/start',{method:'POST',headers:{...remote.headers,'Content-Type':'application/json','X-Breeze-Token':health.token},body:'{}',signal:limited(5000),credentials:'omit'});
        if(!response.ok)throw new Error(`轻声启动请求失败（${response.status}），请重试。`);
        while(Date.now()<deadline){
            await pause();
            const result=await fetch(remote.base+'/status',{headers:remote.headers,signal:limited(5000),credentials:'omit'});
            if(!result.ok)throw new Error('读取启动状态失败，请重试。');
            const status=await result.json();
            if(status.starting)continue;
            if(status.exitCode!==null&&status.exitCode!==undefined&&status.exitCode!==0)throw new Error('轻声启动失败，请手动运行「启动轻声.bat」查看具体原因。');
            if(status.modelReady){onProgress('轻声已就绪。');return;}
            throw new Error('模型尚未就绪，请手动运行「启动轻声.bat」检查。');
        }
        throw new Error('轻声启动超时，请稍后重试。');
    } finally {clearTimeout(timer);}
}
