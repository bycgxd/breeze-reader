import {collectRenderedMessage,makeSentences,renderedSignature} from './rendered.mjs';
import {presentIOSSelection,hideIOSSelection,pointIOSReader,isIOSReader} from './ios-platform.mjs';
import {createPointGesture} from './point-gesture.mjs';

const IGNORE='a,button,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="button"],[data-br-owned],#breeze-reader,#br-bar,#br-settings,pre,code';
const elementOf=node=>node?.nodeType===1?node:node?.parentElement;
const ownMutation=record=>elementOf(record.target)?.closest('[data-br-owned],.mes_buttons') || [...record.addedNodes,...record.removedNodes].every(node=>node.nodeType===1&&node.matches('[data-br-owned]'))&&record.type==='childList'&&record.addedNodes.length+record.removedNodes.length>0;

export function selectedSentences(items,selection) {
    if(!selection || selection.collapsed || !selection.startContainer.isConnected || !selection.endContainer.isConnected)return [];
    const doc=selection.startContainer.ownerDocument,start=selection.cloneRange(),end=selection.cloneRange();
    start.collapse(true);end.collapse(false);
    return items.flatMap((item,index)=>{
        const ranges=[];
        for(const original of item.ranges || []) {
            if(original.startContainer.ownerDocument!==doc || !original.startContainer.isConnected || !original.endContainer.isConnected)continue;
            const left=original.cloneRange(),right=original.cloneRange();left.collapse(true);right.collapse(false);
            if(left.compareBoundaryPoints(0,end)>=0 || right.compareBoundaryPoints(0,start)<=0)continue;
            const clipped=original.cloneRange();
            if(left.compareBoundaryPoints(0,start)<0)clipped.setStart(start.startContainer,start.startOffset);
            if(right.compareBoundaryPoints(0,end)>0)clipped.setEnd(end.startContainer,end.startOffset);
            if(!clipped.collapsed)ranges.push(clipped);
        }
        const text=ranges.map(range=>range.toString()).join('').replace(/\s+/g,' ').trim();
        return text?[{...item,id:item.id+':selection',text,ranges,sourceIndex:item.sourceIndex??index}]:[];
    });
}

export function sentenceAtPoint(items,doc,x,y) {
    let node,offset;
    if(doc.caretPositionFromPoint){const caret=doc.caretPositionFromPoint(x,y);node=caret?.offsetNode;offset=caret?.offset;}
    else if(doc.caretRangeFromPoint){const caret=doc.caretRangeFromPoint(x,y);node=caret?.startContainer;offset=caret?.startOffset;}
    let fallback=-1;
    for(let index=0;index<items.length;index++)for(const range of items[index].ranges || []) {
        if(range.startContainer.ownerDocument!==doc)continue;
        const inside=[...range.getClientRects()].some(rect=>x>=rect.left-1&&x<=rect.right+1&&y>=rect.top&&y<=rect.bottom);
        if(!inside)continue;
        if(fallback<0)fallback=index;
        if(node && range.comparePoint(node,offset)===0 && !(node===range.endContainer&&offset===range.endOffset))return index;
    }
    return fallback;
}

export function createContentInteractions({document:main=document,allowed=()=>true,onRead,onStop,onError=()=>{},enabled=()=>true,clickToRead=()=>false,pointToRead=()=>false}) {
    const documents=new Map(),frames=new Map();
    let popup,style,current,selectionTimer,refreshTimer,clickTimer,disposed=false;
    function hidePopup(){hideIOSSelection();clearTimeout(selectionTimer);selectionTimer=undefined;popup?.remove();style?.remove();popup=style=current=undefined;}
    function hide(){clearTimeout(clickTimer);clickTimer=undefined;hidePopup();}
    function messageFor(doc,node){
        const owner=documents.get(doc)?.message || elementOf(node)?.closest('#chat .mes[mesid]');
        return owner?.isConnected && owner.ownerDocument===main && allowed(Number(owner.getAttribute('mesid')))?owner:null;
    }
    function reportFor(message){
        const report=collectRenderedMessage(message);
        if(!report.blocks.length || report.loadingFrames || report.inaccessibleFrames)return null;
        return {report,items:makeSentences(report.blocks),messageId:Number(message.getAttribute('mesid')),signature:renderedSignature(report.blocks)};
    }
    function selected(doc){
        const selection=doc.getSelection();
        if(!selection || selection.rangeCount!==1 || selection.isCollapsed)return null;
        const range=selection.getRangeAt(0).cloneRange();
        if(!elementOf(range.startContainer)?.closest('#dcRoot') || !elementOf(range.endContainer)?.closest('#dcRoot'))return null;
        if(elementOf(range.startContainer)?.closest(IGNORE) || elementOf(range.endContainer)?.closest(IGNORE))return null;
        const message=messageFor(doc,range.startContainer);
        if(!message || messageFor(doc,range.endContainer)!==message)return null;
        const data=reportFor(message);if(!data)return null;
        const items=selectedSentences(data.items,range);if(!items.length)return null;
        return {...data,range,firstIndex:items[0].sourceIndex,count:items.length};
    }
    function point(event,doc){
        if(elementOf(event.target)?.closest(IGNORE) || !elementOf(event.target)?.closest('#dcRoot'))return null;
        const message=messageFor(doc,event.target),data=message&&reportFor(message);if(!data)return null;
        const firstIndex=sentenceAtPoint(data.items,doc,event.clientX,event.clientY);
        return firstIndex<0?null:{...data,firstIndex};
    }
    function show(data,doc,x,y,context=false){
        hide();current=data;
        if(presentIOSSelection({selected:!!data.range,count:data.count||1,onAction(action){
            const snapshot=data;hide();if(action==='close')return;if(action==='stop'){onStop();return;}try{onRead(snapshot,action);}catch(error){onError(error.message);}
        }}))return;
        popup=doc.createElement('div');popup.dataset.brOwned='interaction';popup.className='br-content-menu';popup.setAttribute('role','toolbar');popup.setAttribute('aria-label','轻声正文朗读');
        style=doc.createElement('style');style.dataset.brOwned='interaction-style';
        style.textContent=`.br-content-menu{position:fixed;z-index:2147483200;box-sizing:border-box;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);overflow:auto;padding:9px;border:1px solid #9db5aa;border-radius:12px;background:#f4f7f3;color:#233b33;box-shadow:0 6px 24px #0003;font:13px/1.6 system-ui,sans-serif;text-align:left;user-select:none}.br-content-menu .br-content-actions{display:flex;gap:5px;flex-wrap:wrap}.br-content-menu button{font:inherit;cursor:pointer;padding:6px 10px;border:1px solid #98b2a5;border-radius:7px;background:#fff;color:#233b33}.br-content-menu button:first-child{background:#487f67;color:white;border-color:#487f67}.br-content-menu button:focus-visible{outline:2px solid #286a50;outline-offset:1px}.br-content-menu small{display:block;font-size:11px;opacity:.75;margin:2px 2px 7px}`;
        (doc.head||doc.documentElement).append(style);
        const title=doc.createElement('small');title.textContent=data.range?`已选中 ${data.count} 句片段，按人物配音`:'本句朗读 · 按人物配音';popup.append(title);
        const actions=doc.createElement('div');actions.className='br-content-actions';popup.append(actions);
        for(const [action,label]of [[data.range?'selection':'sentence',data.range?'朗读选中内容':'读这一句'],['from','从此句继续'],['stop','停止朗读'],['close','关闭']]){
            const button=doc.createElement('button');button.type='button';button.dataset.brAction=action;button.textContent=label;
            button.addEventListener('pointerdown',event=>event.preventDefault());
            button.addEventListener('click',()=>{const snapshot=current;hide();if(action==='close')return;if(action==='stop'){onStop();return;}try{onRead(snapshot,action);}catch(error){onError(error.message);}});
            actions.append(button);
        }
        if(context){const hint=doc.createElement('small');hint.textContent='Shift + 右键可保留浏览器原菜单';hint.style.margin='7px 2px 0';popup.append(hint);}
        popup.addEventListener('keydown',event=>{
            if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
            const buttons=[...popup.querySelectorAll('button')],index=buttons.indexOf(doc.activeElement);
            const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowLeft'?-1:1)+buttons.length)%buttons.length;
            event.preventDefault();buttons[next].focus({preventScroll:true});
        });
        doc.documentElement.append(popup);
        const bounds=popup.getBoundingClientRect(),view=doc.defaultView;
        popup.style.left=Math.max(8,Math.min(x,view.innerWidth-bounds.width-8))+'px';
        popup.style.top=Math.max(8,Math.min(y+10,view.innerHeight-bounds.height-8))+'px';
        if(context)actions.firstElementChild.focus({preventScroll:true});
    }
    function queueSelection(doc){
        clearTimeout(selectionTimer);
        if(doc.getSelection()?.isCollapsed===false)clearTimeout(clickTimer);
        if(popup?.contains(doc.activeElement))return;
        selectionTimer=setTimeout(()=>{
            if(disposed||!enabled()){hide();return;}
            const data=selected(doc);if(!data){hidePopup();return;}
            const rect=data.range.getBoundingClientRect();show(data,doc,rect.left,rect.bottom);
        },100);
    }
    function bind(doc,message){
        const removers=[];let observer,scope;const gesture=createPointGesture();
        const listen=(target,type,fn,options)=>{target.addEventListener(type,fn,options);removers.push(()=>target.removeEventListener(type,fn,options));};
        listen(doc,'selectionchange',()=>{if(doc.getSelection()?.isCollapsed===false)gesture.cancel();queueSelection(doc);});
        listen(doc,'pointerdown',event=>{gesture.down(event);clearTimeout(clickTimer);},true);
        listen(doc,'pointermove',event=>gesture.move(event),true);
        listen(doc,'pointerup',event=>gesture.up(event),true);
        listen(doc,'pointercancel',()=>{gesture.cancel();clearTimeout(clickTimer);},true);
        listen(doc,'pointerup',event=>{if(event.button===0&&!elementOf(event.target)?.closest(IGNORE))queueSelection(doc);});
        listen(doc,'pointerdown',event=>{if(popup&&!popup.contains(event.target))hide();},true);
        listen(doc,'keydown',event=>{if(event.key==='Escape'&&popup){event.preventDefault();hide();}},true);
        listen(doc,'click',event=>{
            if(!enabled()||event.ctrlKey||event.metaKey||event.shiftKey||event.button!==0||doc.getSelection()?.isCollapsed===false)return;
            const pointMode=pointToRead();
            const shortTap=gesture.consume();
            if(pointMode&&!shortTap)return;
            if(!event.altKey&&!clickToRead()&&!pointMode)return;
            if(event.detail>1){clearTimeout(clickTimer);return;}
            const data=point(event,doc);if(!data)return;
            hide();
            if(event.altKey){event.preventDefault();event.stopPropagation();onRead(data,'from');}
            else clickTimer=setTimeout(()=>{if(!disposed&&enabled()&&(pointMode?pointToRead():clickToRead())&&doc.getSelection()?.isCollapsed!==false){if(pointMode){onRead(data,'from');pointIOSReader(data.items[data.firstIndex]);}else onRead(data,'sentence');}},240);
        },true);
        listen(doc,'dblclick',()=>clearTimeout(clickTimer),true);
        listen(doc,'contextmenu',event=>{
            gesture.cancel();clearTimeout(clickTimer);
            if(isIOSReader())return;
            if(event.shiftKey||!enabled()){hide();return;}
            if(elementOf(event.target)?.closest(IGNORE))return;
            const hit=point(event,doc);if(!hit)return;
            const selection=selected(doc);
            const overSelection=selection?.messageId===hit.messageId&&[...selection.range.getClientRects()].some(rect=>event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom);
            const data=overSelection?selection:hit;
            event.preventDefault();event.stopPropagation();show(data,doc,event.clientX,event.clientY,true);
        },true);
        listen(doc,'scroll',()=>{gesture.cancel();hide();},true);listen(doc.defaultView,'resize',hide);
        function watch(){
            const next=doc===main?main.getElementById('chat'):doc.documentElement;
            if(scope===next)return;
            observer?.disconnect();scope=next;if(!scope)return;
            observer=new doc.defaultView.MutationObserver(records=>{
                const changes=records.filter(record=>!ownMutation(record));if(!changes.length)return;
                if(popup?.ownerDocument===doc)hide();
                if(changes.some(record=>[...record.addedNodes,...record.removedNodes].some(node=>node.nodeType===1&&(node.matches('iframe,.mes')||node.querySelector('iframe,.mes'))))){clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,80);}
            });
            observer.observe(scope,{subtree:true,childList:true,characterData:true});
        }
        const entry={message,watch,dispose(){observer?.disconnect();for(const remove of removers)remove();}};
        documents.set(doc,entry);watch();
    }
    function refresh(){
        if(disposed)return;
        const desired=new Map([[main,null]]),wantedFrames=new Set();
        function visit(scope,message){for(const frame of scope.querySelectorAll('iframe')){
            if(frame.closest('#dcRoot,.dc-html-embed')||frame.matches('.dc-html-iframe'))continue;
            wantedFrames.add(frame);
            if(!frames.has(frame)){const loaded=()=>{hide();refresh();};frames.set(frame,loaded);frame.addEventListener('load',loaded);}
            try{const child=frame.contentDocument;if(child?.documentElement&&!desired.has(child)){desired.set(child,message);visit(child,message);}}catch{/* Keep inaccessible frames untouched. */}
        }}
        for(const message of main.querySelectorAll('#chat .mes[mesid]'))visit(message,message);
        for(const [frame,handler]of frames)if(!wantedFrames.has(frame)){frame.removeEventListener('load',handler);frames.delete(frame);}
        for(const [doc,entry]of documents)if(!desired.has(doc)){entry.dispose();documents.delete(doc);if(popup?.ownerDocument===doc)hide();}
        for(const [doc,message]of desired){if(!documents.has(doc))bind(doc,message);else{documents.get(doc).message=message;documents.get(doc).watch();}}
    }
    refresh();
    return {hide,refresh,dispose(){disposed=true;hide();clearTimeout(refreshTimer);for(const entry of documents.values())entry.dispose();documents.clear();for(const [frame,handler]of frames)frame.removeEventListener('load',handler);frames.clear();}};
}
