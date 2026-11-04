export function createSentenceHighlighter() {
    const entries = new Map();
    const key = 'br-reader-active';
    let current;
    function clear() {
        current = undefined;
        for (const [doc,entry] of entries) {
            if (entry.highlight && doc.defaultView?.CSS?.highlights?.get(key) === entry.highlight) doc.defaultView.CSS.highlights.delete(key);
            entry.style?.remove(); entry.overlay?.remove();
            for (const remove of entry.listeners) remove();
        }
        entries.clear();
    }
    function reveal(item = current) {
        if (!item?.element?.isConnected) return;
        const first = item.ranges?.[0];
        const target = first?.startContainer.parentElement || item.element;
        const sourceView = target.ownerDocument.defaultView;
        function rectIn(destination) {
            let rect = first?.getBoundingClientRect() || target.getBoundingClientRect();
            let top = rect.top, bottom = rect.bottom, view = sourceView;
            while (view !== destination && view.frameElement) {
                const frame = view.frameElement, bounds = frame.getBoundingClientRect();
                const scale = frame.offsetHeight ? bounds.height / frame.offsetHeight : 1;
                top = bounds.top + (top + frame.clientTop) * scale;
                bottom = bounds.top + (bottom + frame.clientTop) * scale;
                view = view.parent;
            }
            return {top,bottom};
        }
        let view = target.ownerDocument.defaultView;
        let element = target;
        try {
            while (view) {
                for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                    if (parent.scrollHeight <= parent.clientHeight || !/(auto|scroll)/.test(view.getComputedStyle(parent).overflowY)) continue;
                    const rect = rectIn(view), box = parent.getBoundingClientRect();
                    if (rect.top < box.top + 16 || rect.bottom > box.bottom - 16) parent.scrollTop += rect.top - box.top - parent.clientHeight * .35;
                }
                const rect = rectIn(view);
                if (rect.top < 16 || rect.bottom > view.innerHeight - 16) view.scrollBy({top:rect.top - view.innerHeight * .35,behavior:'auto'});
                if (!view.frameElement) break;
                element = view.frameElement; view = view.parent;
            }
        } catch { /* Keep playback available if a parent frame cannot be scrolled. */ }
    }
    function show(item, follow = false) {
        clear(); current = item;
        const doc = item.element?.ownerDocument;
        if (!doc || !item.element.isConnected) return 'none';
        const view = doc.defaultView;
        const ranges = (item.ranges || []).filter(range => range.startContainer.isConnected && range.endContainer.isConnected);
        const entry = {listeners:[]}; entries.set(doc,entry);
        function listen(target,type,fn) {
            const options = {passive:true,capture:type === 'scroll'};
            target.addEventListener(type,fn,options);
            entry.listeners.push(()=>target.removeEventListener(type,fn,options));
        }
        let mode = ranges.length ? 'sentence' : 'block';
        if (ranges.length && view.CSS?.highlights && view.Highlight) {
            entry.style = doc.createElement('style'); entry.style.dataset.brOwned = 'highlight';
            entry.style.textContent = '::highlight(br-reader-active){background:rgba(102,183,139,.45);color:inherit;}';
            doc.head.append(entry.style);
            entry.highlight = new view.Highlight(...ranges); view.CSS.highlights.set(key,entry.highlight);
        } else {
            entry.overlay = doc.createElement('div'); entry.overlay.dataset.brOwned = 'highlight';
            entry.overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
            doc.documentElement.append(entry.overlay);
            const paint = () => {
                entry.overlay.replaceChildren();
                if (!item.element.isConnected) return;
                const rects = ranges.length ? ranges.flatMap(range=>Array.from(range.getClientRects())) : [item.element.getBoundingClientRect()];
                for (const rect of rects) {
                    if (!rect.width || !rect.height) continue;
                    const mark = doc.createElement('div');
                    mark.style.cssText = `position:absolute;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:rgba(102,183,139,.3);border-radius:3px;`;
                    entry.overlay.append(mark);
                }
            };
            paint(); listen(view,'resize',paint); listen(doc,'scroll',paint);
        }
        if (follow) reveal(item);
        return mode;
    }
    return {show,clear,reveal};
}
