export function waitForStableReport(read,signature,signal,{interval=200,stableMs=600,timeout=15000} = {}) {
    return new Promise((resolve,reject)=>{
        let previous, since=0;
        const started=Date.now();
        const finish=(error,value)=>{clearInterval(timer);signal.removeEventListener('abort',abort);error?reject(error):resolve(value);};
        const abort=()=>finish(new DOMException('Aborted','AbortError'));
        const timer=setInterval(()=>{
            try {
                signal.throwIfAborted();
                const report=read(),now=Date.now();
                if(report.blocks.length && !report.loadingFrames && !report.inaccessibleFrames) {
                    const current=signature(report.blocks);
                    if(current!==previous){previous=current;since=now;}
                    else if(now-since>=stableMs){finish(null,report);return;}
                } else {previous=undefined;since=0;}
                if(now-started>=timeout)finish(new Error('新回复正文尚未稳定或无法访问，请手动识别后朗读。'));
            } catch(error){finish(error);}
        },interval);
        signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted)abort();
    });
}
