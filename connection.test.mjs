import assert from 'node:assert/strict';
import {connection,LOCAL_BRIDGE} from './connection.mjs';
import {bridgeHealth,discoverVoices} from './stream.mjs';
import {startLocalService} from './startup.mjs';
assert.equal(connection().base,LOCAL_BRIDGE);
for(const url of ['file:///tmp','http://u:p@localhost','http://host/?x=1','http://host/#x'])assert.throws(()=>connection({serviceUrl:url}));
const config={serviceUrl:'http://192.168.31.178:8790/',serviceKey:'test-key'};
assert.equal(connection(config).local,false);assert.equal(connection(config).base,'http://192.168.31.178:8790');
const original=globalThis.fetch,requests=[];
try{
    globalThis.fetch=async(url,options)=>{
        requests.push({url,options});
        assert(url.startsWith('http://192.168.31.178:8790/'));assert.equal(options.headers['X-Breeze-Key'],'test-key');
        if(url.endsWith('/health'))return Response.json({bridge:'breeze-reader-3',token:'token'});
        if(url.endsWith('/voices'))return Response.json({voices:[{id:'voice',name:'中文',loaded:true}]});
        if(url.endsWith('/status'))return Response.json({modelReady:true});
        throw Error('Unexpected endpoint');
    };
    assert.equal((await discoverVoices(undefined,config)).voices[0].name,'中文');
    await startLocalService({config,launch(){throw Error('Remote must never launch local protocol');}});
    assert(!requests.some(r=>r.url.endsWith('/start')));
    globalThis.fetch=async()=>new Response('',{status:401});await assert.rejects(bridgeHealth(undefined,config),/密钥/);
    globalThis.fetch=async()=>{throw Error('offline');};await assert.rejects(startLocalService({config,launch(){throw Error('must not launch');}}),/无法连接/);
    console.log('Remote address, key forwarding, discovery, startup isolation and validation passed');
}finally{globalThis.fetch=original;}
