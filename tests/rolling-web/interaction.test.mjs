// Real Chromium DOM/event regression; no wallet, node, signing, broadcasting or chain acceptance claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {build} from 'esbuild';
const bundle=await build({entryPoints:[new URL('../../web/rolling-tn10/interaction.ts',import.meta.url).pathname],bundle:true,write:false,format:'iife',globalName:'KaswinPointer',platform:'browser'});
async function fixture(guarded) {
  const browser=await chromium.launch(),page=await browser.newPage();
  await page.setContent('<main id="view"><button data-act="BUY">BUY initial</button></main>');
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.evaluate(guarded=>{
    const view=document.querySelector('#view');window.clicks=0;window.version='initial';
    let defer=()=>false;
    window.render=()=>{if(!defer())view.innerHTML=`<button data-act="BUY">BUY ${window.version}</button>`;};
    if(guarded)defer=KaswinPointer.deferPointerRender(view,window.render);
    view.addEventListener('click',event=>{if(event.target.closest('[data-act="BUY"]'))window.clicks++;});
    window.original=view.firstElementChild;
  },guarded);
  const box=await page.locator('button').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  return {browser,page};
}
test('baseline: replacing BUY after pointerdown loses the real click',async()=>{
  const {browser,page}=await fixture(false);
  try{await page.mouse.down();await page.evaluate(()=>{window.version='changed';window.render();});await page.mouse.up();assert.equal(await page.evaluate(()=>window.clicks),0);}
  finally{await browser.close();}
});
test('multiple background renders retain the pressed node, deliver one click, then paint latest state',async()=>{
  const {browser,page}=await fixture(true);
  try {
    await page.mouse.down();
    await page.evaluate(()=>{window.version='first';window.render();window.version='latest';window.render();});
    assert.equal(await page.evaluate(()=>window.original===document.querySelector('#view').firstElementChild),true);
    await page.mouse.up();
    await page.waitForFunction(()=>document.querySelector('button').textContent==='BUY latest');
    assert.equal(await page.evaluate(()=>window.clicks),1);
    assert.equal(await page.evaluate(()=>window.original===document.querySelector('#view').firstElementChild),false);
  }finally{await browser.close();}
});
test('pointer cancellation releases a queued render without inventing a click',async()=>{
  const {browser,page}=await fixture(true);
  try {
    await page.mouse.down();await page.evaluate(()=>{window.version='cancelled';window.render();window.dispatchEvent(new PointerEvent('pointercancel'));});
    await page.waitForFunction(()=>document.querySelector('button').textContent==='BUY cancelled');
    assert.equal(await page.evaluate(()=>window.clicks),0);
  }finally{await browser.close();}
});
