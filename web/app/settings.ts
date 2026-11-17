/** Pure validation of the connection settings typed into "高级设置". Nothing here touches the network or storage:
 * a value is only saved after it was accepted by this module AND a real connection attempt with it succeeded (see app.ts onApplyConn). */
const bad = (code: string): Error => Object.assign(new Error(code), {code});
export const MAX_NODES = 8;
/** One wRPC address per line. `ws:`/`wss:` only, a real host, no credentials, no fragment. Empty input means "use the default". */
export function parseNodeList(text: string, fallback: string): string[] {
  const lines = (text.trim() === '' ? fallback : text).split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) throw bad('NODE_URLS_REQUIRED');
  if (lines.length > MAX_NODES) throw bad('NODE_URL_COUNT');
  return lines.map(line => {
    let u: URL;
    try {u = new URL(line);} catch {throw bad('NODE_URL_INVALID');}
    if ((u.protocol !== 'ws:' && u.protocol !== 'wss:') || !u.hostname || line.length > 300 || u.hash) throw bad('NODE_URL_INVALID');
    if (u.username || u.password) throw bad('NODE_URL_CREDENTIALS');
    return line;
  });
}
