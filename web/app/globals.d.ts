/** Build-time module: the authenticated Profile frames are inlined by build/build.mjs (esbuild plugin). */
declare module '@kaswin/rolling-profile' {
  export const profileData: unknown;
}
declare module '@kaswin/kusdt-v2-profile' {
  export const kusdtV2Artifacts: Record<string, unknown>;
  export const kusdtV2Pins: {kusdtCid: string; templates: Record<string, string>};
  export const kusdtV2Kcc20SuffixHex: string;
}
declare const __KASWIN_DEFAULT_NET__: 'mainnet' | 'tn10';
declare const __KASWIN_CD311__: boolean;
declare const __KASWIN_KASPIRE_WC_INTEGRITY__: string;
