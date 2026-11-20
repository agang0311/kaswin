/** Keep the current view nodes alive until a pointer gesture or scroll finishes.
 * Background refreshes may replace the view after the gesture; protocol state continues updating normally. */
export function deferPointerRender(view: HTMLElement,flush: ()=>void): ()=>boolean {
  let held=false,scrolling=false,pending=false,timer: ReturnType<typeof setTimeout>|undefined,scrollTimer: ReturnType<typeof setTimeout>|undefined;
  const maybeFlush=()=>{if(!held&&!scrolling&&pending){pending=false;flush();}};
  view.addEventListener('pointerdown',event=>{
    if(!event.isPrimary||event.button!==0)return;
    clearTimeout(timer);held=true;
  });
  const release=()=>{
    // click follows pointerup. Deferring release one task keeps a refresh between those events from removing the target.
    clearTimeout(timer);
    timer=setTimeout(()=>{held=false;maybeFlush();},0);
  };
  const onScroll=()=>{
    scrolling=true;
    clearTimeout(scrollTimer);
    scrollTimer=setTimeout(()=>{scrolling=false;maybeFlush();},180);
  };
  window.addEventListener('pointerup',release);
  window.addEventListener('pointercancel',release);
  window.addEventListener('blur',release);
  window.addEventListener('scroll',onScroll,{passive:true});
  return ()=>{if(!held&&!scrolling)return false;pending=true;return true;};
}
