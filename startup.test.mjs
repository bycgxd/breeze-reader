import assert from 'node:assert/strict';
import {startLocalService} from './startup.mjs';
const original=globalThis.fetch;
const health=()=>Response.json({bridge:'breeze-reader-3',token:'test-token'});
try{
    let requests=[],polls=0,launches=0;
    globalThis.fetch=async(url,options={})=>{requests.push({url,options});if(url.endsWith('/health'))return health();if(url.endsWith('/start'))return Response.json({starting:true},{status:202});return Response.json(++polls===1?{starting:true}:{starting:false,modelReady:true,exitCode:0});};
    await startLocalService({interval:1,timeout:1000,launch(){launches++;}});
    assert.equal(launches,0);assert.equal(requests.filter(r=>r.url.endsWith('/start')).length,1);assert.equal(requests.find(r=>r.url.endsWith('/start')).options.body,'{}');assert.equal(requests.find(r=>r.url.endsWith('/start')).options.headers['X-Breeze-Token'],'test-token');
    let booted=false;
    globalThis.fetch=async(url)=>{if(url.endsWith('/health')){if(!booted)throw Error('offline');return health();}if(url.endsWith('/start'))return Response.json({starting:true},{status:202});return Response.json({starting:false,modelReady:true,exitCode:0});};
    await startLocalService({interval:1,timeout:1000,launch(){launches++;booted=true;}});assert.equal(launches,1,'Cold start must invoke fixed local launcher exactly once');
    globalThis.fetch=async(url)=>url.endsWith('/health')?health():url.endsWith('/start')?new Response('Forbidden',{status:403}):health();
    await assert.rejects(startLocalService({interval:1,timeout:1000}),/403/);
    globalThis.fetch=async(url)=>url.endsWith('/health')?health():url.endsWith('/start')?Response.json({starting:true}):Response.json({starting:false,modelReady:false,exitCode:1});
    await assert.rejects(startLocalService({interval:1,timeout:1000}),/启动失败/);
    const ctrl=new AbortController();ctrl.abort();await assert.rejects(startLocalService({signal:ctrl.signal,interval:1,timeout:1000}),{name:'AbortError'});
    globalThis.fetch=async()=>{throw Error('offline');};await assert.rejects(startLocalService({interval:1,timeout:10,launch(){}}),/启动未完成|启动超时|无法连接/);
    console.log('Startup checks passed: warm/cold paths, fixed empty request, token, errors, cancellation and deadline');
}finally{globalThis.fetch=original;}
