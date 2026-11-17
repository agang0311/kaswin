/** Keep the current view nodes alive until a pointer gesture has delivered its click.
 * Background refreshes may replace the view after the gesture; protocol state continues updating normally. */
export function deferPointerRender(view: HTMLElement,flush: ()=>void): ()=>boolean {
  let held=false,pending=false,timer: ReturnType<typeof setTimeout>|undefined;
  view.addEventListener('pointerdown',event=>{
    if(!event.isPrimary||event.button!==0)return;
    clearTimeout(timer);held=true;
  });
  const release=()=>{
    // click follows pointerup. Deferring release one task keeps a refresh between those events from removing the target.
    clearTimeout(timer);
    timer=setTimeout(()=>{held=false;if(pending){pending=false;flush();}},0);
  };
  window.addEventListener('pointerup',release);
  window.addEventListener('pointercancel',release);
  window.addEventListener('blur',release);
  return ()=>{if(!held)return false;pending=true;return true;};
}
