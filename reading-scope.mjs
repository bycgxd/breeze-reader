// Preserve original items and DOM ranges; filter only the playback queue.
export function scopeItems(items,dialogueOnly=false) {
    return items.filter(item=>!dialogueOnly||item.kind==='dialogue');
}
export function scopeStart(items,start,{sourceStart=false,single=false}={}) {
    if(!Number.isInteger(start)||start<0)return -1;
    if(!sourceStart)return start<items.length?start:-1;
    return items.findIndex(item=>single?item.sourceIndex===start:item.sourceIndex>=start);
}
