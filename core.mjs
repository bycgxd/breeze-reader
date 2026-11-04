export const DEFAULTS = {
    serviceUrl: '', serviceKey: '',
    voice: 'xuanxuan', voices: ['xuanxuan', 'lilida'], rate: 1,
    auto: false, characterVoices: {}, profiles: {}, follow: false,
    cacheEnabled: true, voiceLabels: {},
    voiceRevisions: {}, voiceNames: {}, contentInteractions: true, clickToRead: false, tapToContinue: false, dialogueOnly: false,
};

export function validateEndpoint(value) {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('请输入不包含账号密码的 HTTP 服务地址。');
    }
    if (url.search || url.hash) throw new Error('服务地址不应包含查询参数或片段。');
    url.pathname = url.pathname.replace(/\/$/, '').replace(/(?:\/v1)?(?:\/audio\/speech)?$/, '') + '/v1/audio/speech';
    return url.href;
}

export function cleanText(text) {
    return String(text ?? '')
        .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
        .replace(/<(script|style|think|thinking|analysis|reasoning|draft|cot)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
        .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]*>/g, '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
        .replace(/&(?:lt|gt|quot|apos);/gi, '')
        .replace(/^[ \t]*#{1,6}\s+/gm, '')
        .replace(/[*_`~]/g, '').replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n').trim();
}

export function splitText(text) {
    const chunks = [];
    let current = '';
    let length = 0;
    for (const char of text) {
        current += char;
        length++;
        if (length >= 2000) {
            if (current.trim()) chunks.push(current.trim());
            current = ''; length = 0;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

export function voiceFor(config, character) {
    return Object.hasOwn(config.characterVoices,character) ? config.characterVoices[character] || config.voice : config.voice;
}

export function applyVoiceCatalog(config, rows) {
    const aliases=new Map();
    for(const row of rows)for(const name of [row.id,...(Array.isArray(row.aliases)?row.aliases:[])])if(typeof name==='string'&&!aliases.has(name))aliases.set(name,row.id);
    for(const [oldId,revision]of Object.entries(config.voiceRevisions || {})){
        const matches=rows.filter(row=>row.legacyRevision && row.legacyRevision===revision);
        if(matches.length===1)aliases.set(oldId,matches[0].id);
    }
    const migrate=value=>aliases.get(value)||value;
    config.voice=migrate(config.voice);
    for(const profile of [config,...Object.values(config.profiles || {})]) {
        if(!profile || typeof profile!=='object')continue;
        for(const key of ['defaultVoice','narrator','thought'])if(profile[key])profile[key]=migrate(profile[key]);
        for(const field of ['voices','characterVoices'])if(profile[field]&&!Array.isArray(profile[field]))for(const key of Object.keys(profile[field]))Object.defineProperty(profile[field],key,{value:migrate(profile[field][key]),writable:true,enumerable:true,configurable:true});
    }
    for(const [name,label]of Object.entries(config.voiceLabels || {})){const id=migrate(name);if(id!==name&&!Object.hasOwn(config.voiceLabels,id))Object.defineProperty(config.voiceLabels,id,{value:label,writable:true,enumerable:true,configurable:true});}
    config.voices=rows.map(row=>row.id);
    config.voiceNames=Object.fromEntries(rows.map(row=>[row.id,row.name??row.id]));
    config.voiceRevisions=Object.fromEntries(rows.map(row=>[row.id,row.revision]));
    if(!config.voices.includes(config.voice))config.voice=config.voices[0];
    return aliases;
}

export function sentenceSpans(text) {
    const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh-CN', {granularity:'sentence'}) : null;
    const spans = [];
    for (const line of text.matchAll(/[^\n]+/g)) {
        const parts = segmenter ? segmenter.segment(line[0]) : line[0].matchAll(/[^。！？!?]+[。！？!?]*|[。！？!?]+/g);
        for (const part of parts) {
            const value = part.segment ?? part[0];
            const leading = value.length - value.trimStart().length;
            const end = value.trimEnd().length;
            if (end <= leading) continue;
            spans.push({start:line.index + part.index + leading, end:line.index + part.index + end, text:value.slice(leading,end).replace(/\s+/g,' ')});
        }
    }
    return spans;
}

export function readingSpans(text,kind) {
    if(kind!=='dialogue'&&kind!=='thought')return sentenceSpans(text);
    const start=text.length-text.trimStart().length,end=text.trimEnd().length;
    return end>start?[{start,end,text:text.slice(start,end).replace(/\s+/g,' ')}]:[];
}

export function sentenceVoice(profile, sentence, fallback) {
    if(profile.mode==='single')return fallback;
    const key = (sentence.speakerKey || sentence.speaker || '').trim().toLowerCase();
    if (sentence.kind === 'narration') return profile.narrator || fallback;
    if (sentence.kind === 'thought' && profile.thought) return profile.thought;
    return Object.hasOwn(profile.voices || {},key) ? profile.voices[key] || fallback : fallback;
}

export async function asWav(blob) {
    const header = new TextDecoder('ascii').decode(await blob.slice(0, 12).arrayBuffer());
    if (blob.size < 44 || header.slice(0, 4) !== 'RIFF' || header.slice(8, 12) !== 'WAVE') {
        throw new Error('服务未返回有效的 WAV 音频，请检查语音接口。');
    }
    // SillyTavern's speech proxy always labels its response audio/mpeg.
    return blob.slice(0, blob.size, 'audio/wav');
}
