export const LOCAL_BRIDGE='http://127.0.0.1:8789';

export function connection(config={}) {
    const url=new URL((config.serviceUrl||LOCAL_BRIDGE).trim());
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('请输入不含账号、查询参数和片段的 HTTP/HTTPS 轻声接口地址。');
    const base=url.href.replace(/\/+$/,'');
    const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    const key=(config.serviceKey||'').trim();
    if(/[\r\n]/.test(key))throw new Error('连接密钥不能包含换行。');
    return {base,local,headers:key?{'X-Breeze-Key':key}:{}};
}
