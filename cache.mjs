export const CACHE_LIMIT = 500 * 1024 * 1024;
export async function audioKey(endpoint, voice, text) {
    const input = JSON.stringify(['breeze-wav-v2',endpoint,'tts-1',voice,'wav',1,text]);
    // LAN HTTP pages may lack SubtleCrypto; exact serialized keys also avoid collisions.
    if(!crypto.subtle)return input;
    const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
}

export function createAudioCache(namespace,{storage = globalThis.indexedDB,limit = CACHE_LIMIT,onWarning = () => {}} = {}) {
    let database, warned = false, epoch = 0, memoryOnly = false;
    const memory = new Map();
    function warn() { if (!warned) { warned = true; onWarning('浏览器持久缓存不可用，本次改用内存缓存，刷新后需重新生成。'); } }
    async function open() {
        if (!database) database = new Promise((resolve,reject)=>{
            if (!storage) { reject(new Error('IndexedDB unavailable')); return; }
            const request = storage.open('breeze-reader-audio',1);
            request.onupgradeneeded = () => {
                const store = request.result.createObjectStore('audio',{keyPath:'id'});
                store.createIndex('namespace','namespace');
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('Cache blocked'));
        });
        return database;
    }
    async function transact(work, fallback) {
        if(memoryOnly)return fallback();
        try {
            const db = await open();
            return await new Promise((resolve,reject)=>{
                const tx = db.transaction('audio','readwrite');
                let result;
                work(tx.objectStore('audio'),value=>{ result=value; });
                tx.oncomplete = () => resolve(result);
                tx.onerror = tx.onabort = () => reject(tx.error || new Error('Cache write failed'));
            });
        } catch { memoryOnly=true;warn(); return fallback(); }
    }
    const audioBlob=value=>value instanceof ArrayBuffer||ArrayBuffer.isView(value)?new Blob([value],{type:'audio/wav'}):value;
    const id = key => `${namespace}:${key}`;
    function trim(rows,remove) {
        let bytes = rows.reduce((sum,row)=>sum+row.bytes,0);
        for (const row of rows.sort((a,b)=>a.used-b.used)) {
            if (bytes<=limit) break;
            remove(row.id); bytes-=row.bytes;
        }
    }
    return {
        get epoch() { return epoch; },
        async get(key,owner) {
            return transact((store,done)=>{
                const request=store.get(id(key));
                request.onsuccess=()=>{
                    const row=request.result;
                    if (row) { row.used=Date.now(); if(!row.owners.includes(owner))row.owners.push(owner);store.put(row); }
                    done(audioBlob(row?.blob));
                };
            },()=>{const row=memory.get(id(key));if(row){row.used=Date.now();if(!row.owners.includes(owner))row.owners.push(owner);}return audioBlob(row?.blob);});
        },
        async put(key,owner,blob,version = epoch) {
            if (version!==epoch || blob.size>limit) return;
            const payload=globalThis.__nativeIOSReader?.version===1?await blob.arrayBuffer():blob;
            const row={id:id(key),namespace,owners:[owner],blob:payload,bytes:blob.size,used:Date.now()};
            return transact((store)=>{
                if(version!==epoch)return;
                const existing=store.get(row.id);
                existing.onsuccess=()=>{
                    row.owners=[...new Set([...(existing.result?.owners || []),owner])];store.put(row);
                    const rows=[];const cursor=store.index('namespace').openCursor(namespace);
                    cursor.onsuccess=()=>{const c=cursor.result;if(c){rows.push({id:c.value.id,bytes:c.value.bytes,used:c.value.used});c.continue();}else trim(rows,key=>store.delete(key));};
                };
            },()=>{if(version!==epoch)return;memory.set(row.id,row);trim([...memory.values()],key=>memory.delete(key));});
        },
        async stats() {
            return transact((store,done)=>{
                let bytes=0,count=0;const cursor=store.index('namespace').openCursor(namespace);
                cursor.onsuccess=()=>{const c=cursor.result;if(c){bytes+=c.value.bytes;count++;c.continue();}else done({bytes,count,persistent:true});};
            },()=>({bytes:[...memory.values()].reduce((n,r)=>n+r.bytes,0),count:memory.size,persistent:false}));
        },
        async clear(owner) {
            epoch++;
            function remove(row,del,put) {
                if(owner===undefined)del(row.id);
                else { row.owners=row.owners.filter(value=>value!==owner);if(!row.owners.length)del(row.id);else put(row); }
            }
            return transact((store)=>{
                const cursor=store.index('namespace').openCursor(namespace);
                cursor.onsuccess=()=>{const c=cursor.result;if(c){if(owner===undefined || c.value.owners.includes(owner))remove(c.value,key=>store.delete(key),row=>store.put(row));c.continue();}};
            },()=>{for(const row of memory.values())if(owner===undefined || row.owners.includes(owner))remove(row,key=>memory.delete(key),row=>memory.set(row.id,row));});
        },
        close() { database?.then(db=>db.close()).catch(()=>{}); },
    };
}
