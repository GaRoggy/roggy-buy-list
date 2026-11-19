/* Shared 500 ms completion: draw for 160 ms, then shrink and close the space. */
window.ListCompletion=(()=>{
  const active=new WeakMap();
  let running=0;
  const easing="cubic-bezier(.22,.75,.2,1)";
  const icon=()=>'<svg class="completion-check" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 12 5 5 9-10" pathLength="1"/></svg>';

  function deferRender(container,render){
    const state=active.get(container);
    if(!state?.count)return false;
    state.render=render;
    return true;
  }

  async function complete(card,button,{remove=true,emptyHTML=""}={}){
    const row=card?.closest(".completion-row"),container=row?.parentElement;
    if(!row||!container||row.classList.contains("completion-running"))return;
    const state=active.get(container)||{count:0,render:null};
    state.count++;active.set(container,state);
    running++;document.documentElement.classList.add("list-completing");
    const keyboardFocus=button?.matches(":focus-visible");
    const focusTarget=(row.nextElementSibling||row.previousElementSibling)?.querySelector("button");
    row.classList.add("completion-running");
    card.setAttribute("aria-busy","true");
    if(button){
      button.innerHTML=icon();button.classList.add("completion-checked");
      button.setAttribute("aria-pressed","true");button.disabled=true;
    }
    const reduced=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animations=[];
    const startTime=document.timeline.currentTime;
    let cleanupTimer;
    const animate=(element,frames,options)=>{
      const animation=element.animate(frames,{fill:"forwards",...options});
      // Use one clock for the stroke and layout, even if a tab delays its next frame.
      if(startTime!=null)animation.startTime=startTime;
      animations.push(animation);
      return animation.finished.catch(()=>{});
    };
    try{
      if(!reduced&&typeof row.animate==="function"){
        const effects=[];
        const path=button?.querySelector("path");
        if(path)effects.push(animate(path,[{strokeDashoffset:1},{strokeDashoffset:0}],{duration:160,easing:"ease-out"}));
        if(remove){
          const height=row.getBoundingClientRect().height,margin=getComputedStyle(row).marginBottom;
          // Each row owns its spacing, so the gap closes with the card, without a final jump.
          row.style.height=height+"px";row.style.marginBottom=margin;row.style.overflow="hidden";
          const others=[...container.querySelectorAll(":scope > .completion-row:not(.completion-running)")];
          if(!others.length&&emptyHTML&&!container.querySelector(".completion-empty")){
            const empty=document.createElement("div");empty.className="completion-empty";
            empty.innerHTML=emptyHTML;container.appendChild(empty);
            const emptyHeight=empty.getBoundingClientRect().height;
            effects.push(animate(empty,[{height:"0px",opacity:0},{height:emptyHeight+"px",opacity:1}],{delay:160,duration:340,easing}));
          }
          effects.push(animate(row,[{height:height+"px",marginBottom:margin},{height:"0px",marginBottom:"0px"}],{delay:160,duration:340,easing}));
          effects.push(animate(card,[{opacity:1,transform:"scale(1)"},{opacity:0,transform:"scale(.88)"}],{delay:160,duration:340,easing}));
        }
        // Background tabs can postpone Animation.finished until a later frame.
        await Promise.race([Promise.all(effects),new Promise(resolve=>{cleanupTimer=setTimeout(resolve,remove?500:160)})]);
      }
      if(remove)row.remove();
      if(keyboardFocus&&focusTarget?.isConnected&&(document.activeElement===document.body||document.activeElement===button))focusTarget.focus({preventScroll:true});
    }finally{
      clearTimeout(cleanupTimer);
      animations.forEach(animation=>animation.cancel());
      row.classList.remove("completion-running");card.removeAttribute("aria-busy");
      state.count--;
      if(!state.count){active.delete(container);state.render?.()}
      if(!--running)document.documentElement.classList.remove("list-completing");
    }
  }
  return {icon,complete,deferRender};
})();
