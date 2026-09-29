/* Roggy Lists interaction polish v109 */
(()=>{
  const root=document.documentElement;
  const drawer=document.getElementById("moreToggle");
  const settings=document.getElementById("settingsToggle");

  // Keep a scrolled-state hook for header contrast without recalculating layout.
  const syncScroll=()=>root.classList.toggle("has-scrolled",window.scrollY>8);
  syncScroll();
  addEventListener("scroll",syncScroll,{passive:true});

  // Any working shelf destination should close the drawer automatically.
  document.querySelectorAll(".side-drawer .drawer-page-tab:not(:disabled)").forEach(btn=>{
    btn.addEventListener("click",()=>{ if(drawer) drawer.checked=false; });
  });

  // Escape always backs out of transient UI before doing anything else.
  addEventListener("keydown",e=>{
    if(e.key!== "Escape") return;
    const openDialog=[...document.querySelectorAll("dialog[open]")].at(-1);
    if(openDialog){ openDialog.close(); return; }
    if(settings?.checked){ settings.checked=false; return; }
    if(drawer?.checked){ drawer.checked=false; }
  });

  // Keep aria-current synchronized with visual tab state.
  const syncTabs=()=>document.querySelectorAll(".page-tab").forEach(tab=>{
    if(tab.classList.contains("active")) tab.setAttribute("aria-current","page");
    else tab.removeAttribute("aria-current");
  });
  syncTabs();
  new MutationObserver(syncTabs).observe(document.body,{subtree:true,attributes:true,attributeFilter:["class"]});

  // Expose connection state for CSS/future diagnostics.
  const syncOnline=()=>root.dataset.network=navigator.onLine?"online":"offline";
  syncOnline();
  addEventListener("online",syncOnline);
  addEventListener("offline",syncOnline);

  // Mark mouse vs keyboard intent so focus treatment stays clean.
  addEventListener("keydown",e=>{ if(e.key==="Tab") root.dataset.input="keyboard"; },true);
  addEventListener("pointerdown",()=>{ root.dataset.input="pointer"; },true);
})();
