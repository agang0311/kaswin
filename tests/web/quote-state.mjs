/** Read the page's own quote state.
 *
 *  Real DOM (V2.0.2 page):
 *    #sign    "签名并提交" — disabled while the quote is stale OR while #approve is unchecked.
 *             So "enabled" is NOT the readiness signal; we must look at the quote itself.
 *    #approve the per-transaction approval checkbox (must be checked before signing)
 *    #cancel  close, #mClose header close
 *    #pErr / #xErr  plan and execution errors
 *
 *  Readiness therefore = the modal produced a concrete plan (outputs/fee rendered) and #sign
 *  exists and is not disabled for the *stale* reason. We check `#approve.disabled`: the page
 *  disables the checkbox itself when the quote cannot be approved.
 */
export async function readQuoteState(page){
  const s = await page.evaluate(() => {
    const t = id => { const el = document.getElementById(id); return el ? (el.textContent || '') : ''; };
    const sign = document.getElementById('sign');
    const approve = document.getElementById('approve');
    const modal = document.getElementById('modal');
    const mt = modal ? (modal.textContent || '') : '';
    return {
      pErr: t('pErr'), xErr: t('xErr'),
      signFound: !!sign,
      signDisabled: sign ? !!sign.disabled : true,
      signText: sign ? (sign.textContent || '').trim() : '',
      approveFound: !!approve,
      approveDisabled: approve ? !!approve.disabled : true,
      approveChecked: approve ? !!approve.checked : false,
      modalOpen: modal ? modal.hasAttribute('open') : false,
      modalText: mt,
      hasPlan: /全部输出|输出（|网络费|Network fee|合计|Total/.test(mt),
    };
  });
  const error = [s.pErr, s.xErr].filter(Boolean).join(' ').trim();
  // Ready: the modal rendered a plan and the approval box is offered (not disabled by the page).
  const ready = s.modalOpen && s.hasPlan && s.approveFound && !s.approveDisabled && !error;
  return {
    ready,
    error,
    text: s.modalText,
    record: /已有未完成|上一笔|待确认的交易|未完成的交易/.test(s.modalText),
    modalOpen: s.modalOpen,
  };
}

export async function waitForQuote(page, {timeoutMs = 30_000, intervalMs = 250} = {}){
  const t0 = Date.now();
  let last = await readQuoteState(page);
  while (Date.now() - t0 < timeoutMs){
    if (last.ready || last.error.trim() || last.record) return last;
    await page.waitForTimeout(intervalMs);
    last = await readQuoteState(page);
  }
  return last;
}

export async function quoteSnapshot(page){ return readQuoteState(page); }
