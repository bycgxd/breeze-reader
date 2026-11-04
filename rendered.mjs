const SKIP = 'script,style,template,xmp,textarea,input,button,select,pre,code,iframe,svg,canvas,audio,video,img,[role="button"],[contenteditable="true"],[data-br-owned]';
const BLOCK = /^(P|DIV|LI|BLOCKQUOTE|H[1-6]|TR)$/;

function visible(element) {
    const view = element.ownerDocument.defaultView;
    for (let node = element; node; node = node.parentElement) {
        if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
        const style = view?.getComputedStyle(node);
        if (style && (style.display === 'none' || /^(hidden|collapse)$/.test(style.visibility))) return false;
    }
    return true;
}

export function renderedTextMap(element) {
    const result = {text:'',positions:[]};
    if (!element || !visible(element)) return result;
    function newline() { result.text += '\n'; result.positions.push(null); }
    function walk(node) {
        if (node.nodeType === 3) {
            result.text += node.nodeValue;
            for (let offset = 0; offset < node.nodeValue.length; offset++) result.positions.push({node,offset});
            return;
        }
        if (node.nodeType !== 1 || node.matches(SKIP) || !visible(node)) return;
        if (node.tagName === 'BR') { newline(); return; }
        if (BLOCK.test(node.tagName)) newline();
        for (const child of node.childNodes) walk(child);
        if (BLOCK.test(node.tagName)) newline();
    }
    walk(element);
    return result;
}

export function visibleText(element) {
    return renderedTextMap(element).text.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function makeSentences(blocks) {
    return blocks.flatMap(block => {
        const mapped = renderedTextMap(block.content);
        return readingSpans(mapped.text,block.kind).map((span,index) => {
            const ranges = [];
            let group;
            function flush() {
                if (!group) return;
                const range = group.node.ownerDocument.createRange();
                range.setStart(group.node,group.start); range.setEnd(group.node,group.end);
                ranges.push(range); group = undefined;
            }
            for (let i = span.start; i < span.end; i++) {
                const point = mapped.positions[i];
                if (!point) { flush(); continue; }
                if (group?.node === point.node && group.end === point.offset) group.end++;
                else { flush(); group = {node:point.node,start:point.offset,end:point.offset+1}; }
            }
            flush();
            return {...block,id:`b${block.index}s${index}`,text:span.text,ranges};
        });
    });
}

export function renderedSignature(blocks) {
    return JSON.stringify(blocks.map(({kind,speakerKey,emotion,emotionGroup,text}) => [kind,speakerKey,emotion,emotionGroup,text]));
}

export function collectRenderedMessage(message) {
    const report = {blocks:[], roots:0, accessibleFrames:0, inaccessibleFrames:0, loadingFrames:0, embeddedFrames:0};
    const documents = new Set();
    const frames = new Set();
    const roots = new Set();
    function readRoot(root) {
        if (roots.has(root) || !visible(root)) return;
        roots.add(root);
        report.roots++;
        for (const element of root.querySelectorAll('.dc-msg,.dc-narration-block')) {
            if (element.parentElement.closest('.dc-msg,.dc-narration-block') || !visible(element)) continue;
            const dialogue = element.matches('.dc-msg');
            const content = dialogue ? element.querySelector('.dc-msg-text-content') : element;
            const text = visibleText(content);
            if (!text) continue;
            report.blocks.push({
                index:report.blocks.length,
                kind:dialogue ? (element.dataset.thought === '1' ? 'thought' : 'dialogue') : 'narration',
                speaker:dialogue ? visibleText(element.querySelector('.dc-msg-name')) : '',
                speakerKey:dialogue ? element.dataset.name || '' : '',
                emotion:dialogue ? visibleText(element.querySelector('.dc-msg-mood')) : '',
                emotionGroup:dialogue ? element.dataset.moodGroup || '' : '',
                text, element, content,
            });
        }
    }
    function visit(scope) {
        for (const element of scope.querySelectorAll('#dcRoot,iframe')) {
            if (!visible(element)) continue;
            if (element.id === 'dcRoot') {
                if (!element.parentElement?.closest('#dcRoot')) readRoot(element);
                continue;
            }
            if (frames.has(element)) continue;
            frames.add(element);
            if (element.closest('#dcRoot,.dc-html-embed') || element.matches('.dc-html-iframe')) {
                report.embeddedFrames++;
                continue;
            }
            try {
                const doc = element.contentDocument || element.contentWindow?.document;
                if (!doc?.documentElement) { report.loadingFrames++; continue; }
                report.accessibleFrames++;
                if (documents.has(doc)) continue;
                documents.add(doc);
                if (doc.readyState === 'loading') report.loadingFrames++;
                visit(doc);
            } catch {
                report.inaccessibleFrames++;
            }
        }
    }
    if (message) visit(message.querySelector('.mes_text') || message);
    return report;
}

export function renderedSummary(report) {
    if (!report.roots) {
        if (report.inaccessibleFrames) return '正文 iframe 无法访问，未读取原始消息。';
        if (report.loadingFrames) return '正文 iframe 正在加载，请稍后重新识别。';
        return '未找到已渲染的正文区域；请先加载消息并等待正文渲染。';
    }
    const counts = {dialogue:0,narration:0,thought:0};
    for (const block of report.blocks) counts[block.kind]++;
    const total = report.blocks.length;
    let result = total ? `共 ${total} 块：对白 ${counts.dialogue} · 旁白/动作 ${counts.narration} · 心理 ${counts.thought}` : '已找到正文区域，但没有可朗读的可见文字。';
    if (report.inaccessibleFrames) result += `；另有 ${report.inaccessibleFrames} 个 iframe 无法访问，清单可能不完整`;
    if (report.loadingFrames) result += '；部分 iframe 仍在加载';
    return result;
}

export function observeRenderedMessage(message, update) {
    let stopped = false, timer;
    const observers = [];
    const loadHandlers = [];
    function detach() {
        for (const observer of observers.splice(0)) observer.disconnect();
        for (const [frame, handler] of loadHandlers.splice(0)) frame.removeEventListener('load', handler);
    }
    function schedule() {
        if (stopped) return;
        clearTimeout(timer);
        timer = setTimeout(refresh, 160);
    }
    function watch(scope, seen) {
        const doc = scope.ownerDocument || scope;
        const Observer = doc.defaultView?.MutationObserver;
        if (Observer) {
            const observer = new Observer(records => {
                if (records.some(record => {
                    const parent = record.target.nodeType === 1 ? record.target : record.target.parentElement;
                    if (parent?.closest('.mes_buttons,[data-br-owned]')) return false;
                    const nodes = [...record.addedNodes,...record.removedNodes];
                    return !nodes.length || !nodes.every(node => node.nodeType === 1 && node.matches('[data-br-owned]'));
                })) schedule();
            });
            observer.observe(scope, {subtree:true,childList:true,characterData:true,attributes:true});
            observers.push(observer);
        }
        for (const frame of scope.querySelectorAll('iframe')) {
            if (frame.closest('#dcRoot,.dc-html-embed') || frame.matches('.dc-html-iframe')) continue;
            frame.addEventListener('load', schedule);
            loadHandlers.push([frame,schedule]);
            try {
                const child = frame.contentDocument || frame.contentWindow?.document;
                if (child?.documentElement && !seen.has(child)) {
                    seen.add(child); watch(child.documentElement, seen);
                }
            } catch { /* Cross-origin frames remain unavailable; no permission changes. */ }
        }
    }
    function refresh() {
        if (stopped) return;
        detach();
        if (message.isConnected) watch(message, new Set());
        update(collectRenderedMessage(message.isConnected ? message : null));
    }
    refresh();
    return () => { stopped = true; clearTimeout(timer); detach(); };
}
import { readingSpans } from './core.mjs';

