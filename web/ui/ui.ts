/** Presentation helpers for the standalone rolling page. Every interpolated value is HTML-escaped unless it was
 * explicitly wrapped by raw()/html(); nothing here touches keys, nodes, wallets or transactions. */
import {icon} from './icons.mjs';
const ESC: Record<string, string> = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
export const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, c => ESC[c] as string);
/** Already-safe markup. Only html``, raw() and ic() create one. */
export class Raw {s: string; constructor(s: string) {this.s = s;}}
export const raw = (s: unknown): Raw => new Raw(String(s));
const fmt = (v: unknown): string => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : v == null || v === false ? '' : esc(v);
/** Tagged template: values are escaped, nested html`` fragments and arrays of them are inserted as-is. */
export const html = (strs: TemplateStringsArray, ...vals: unknown[]): Raw => new Raw(strs.reduce((o, s, i) => o + s + (i < vals.length ? fmt(vals[i]) : ''), ''));
export const ic = (name: string): Raw => raw(icon(name));
export const put = (el: HTMLElement, r: Raw | string): void => {el.innerHTML = r instanceof Raw ? r.s : esc(r);};
export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/** A modal <dialog> sits in the top layer, so a toast in the page-level container would be hidden behind it: while one is open, toasts go into the dialog's own container. */
export function toast(msg: string, tone = ''): void {
  const d = document.createElement('div'); d.className = 'toast ' + tone; d.textContent = msg; d.setAttribute('role', tone === 'bad' ? 'alert' : 'status');
  $(modalOpen() ? 'mToasts' : 'toasts').append(d);
  setTimeout(() => d.remove(), tone === 'bad' ? 9000 : 4500);
}
export function copyText(t: string): Promise<void> {
  if (navigator.clipboard && globalThis.isSecureContext) return navigator.clipboard.writeText(t);
  const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.append(ta); ta.select();
  const ok = document.execCommand('copy'); ta.remove(); return ok ? Promise.resolve() : Promise.reject(new Error('copy'));
}
export function download(name: string, text: string, type = 'application/json'): void {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], {type})); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
/* One shared <dialog>. While `busy` the user cannot dismiss it (signing / sending must not be interrupted). */
let cleanup: (() => void) | null = null, busy = false;
export const modalOpen = (): boolean => $<HTMLDialogElement>('modal').open;
export function lockModal(b: boolean): void {busy = b; $<HTMLButtonElement>('mClose').disabled = b;}
export function modal(title: string, body: Raw | string, foot: Raw | null = null, {onClose = null, kind = ''}: {onClose?: (() => void) | null; kind?: string} = {}): void {
  cleanup?.(); cleanup = onClose;
  $('mTitle').dataset.sourceTitle = title;
  $('mTitle').dataset.modalKind = kind;
  $('mTitle').textContent = title; put($('mBody'), body);
  if (foot) {put($('mFoot'), foot); $('mFoot').hidden = false;} else {$('mFoot').replaceChildren(); $('mFoot').hidden = true;}
  const d = $<HTMLDialogElement>('modal'); if (!d.open) d.showModal();
  $('mBody').scrollTop = 0;
}
export function closeModal(): void {
  if (busy) return; const f = cleanup; cleanup = null; const d = $<HTMLDialogElement>('modal'); if (d.open) d.close(); f?.();
}
export function initModal(): void {
  $('mClose').onclick = closeModal;
  $('modal').addEventListener('cancel', ev => {if (busy) {ev.preventDefault(); return;} const f = cleanup; cleanup = null; f?.();});
}
