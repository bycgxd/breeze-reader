// Only classifies gestures; DOM identity and text validation remain in interaction.mjs.
export function createPointGesture({distance=10,duration=450,now=()=>performance.now()}={}) {
    let press=null,eligible=false;
    return {
        down(event){eligible=false;press=event.isPrimary===false||event.button>0?null:{id:event.pointerId,x:event.clientX,y:event.clientY,time:now()};},
        move(event){if(press&&event.pointerId===press.id&&Math.hypot(event.clientX-press.x,event.clientY-press.y)>distance)press=null;},
        up(event){eligible=!!press&&event.pointerId===press.id&&now()-press.time<duration&&Math.hypot(event.clientX-press.x,event.clientY-press.y)<=distance;press=null;},
        cancel(){press=null;eligible=false;},
        consume(){const result=eligible;eligible=false;return result;}
    };
}
