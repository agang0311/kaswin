/** Release-only safety gate. The bundler MUST replace the identifier with a literal
 * boolean after reviewed budget evidence or explicit bounded TN10 candidate evidence
 * (true), or for a read-only candidate (false). True is NOT public-launch approval.
 * No URL, storage, globalThis property or UI control may override a bundled value.
 * Raw Node modules are a development API, not a released application; browser source
 * without the bundler fails closed. This lets isolated existing Node simulations use
 * the engine without pretending that a published profile has passed the release gate. */
export const TRADING_ENABLED = typeof __KASWIN_RELEASE_TRADING__ === 'boolean'
  ? __KASWIN_RELEASE_TRADING__ : typeof window === 'undefined';
export function requireTradingRelease() {
  if (!TRADING_ENABLED) throw new Error('READ_ONLY_CANDIDATE: 未满足交易发布门槛，禁止签名和提交。Trading release gate is not satisfied; signing and submission are disabled.');
}
