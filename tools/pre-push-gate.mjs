// Git pre-push gate: main is published by Cloudflare Pages, so a push to main that changes the published page is
// refused unless that exact page passed tools/check-deployed.mjs on the internal test URL and is still served there.
// Install (local, per clone):  git config kaswin.internalUrl https://host/path.html
//                              printf '#!/bin/sh\nexec node tools/pre-push-gate.mjs "$@"\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push
// Pushes that leave releases/kaswin-v2/index.html unchanged (docs, tests, sources without a rebuild) pass through.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const REL = 'releases/kaswin-v2/index.html', ZERO = /^0+$/;
const git = (...a) => execFileSync('git', a, {cwd: repo, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore']});
const blob = (rev) => { try { return git('show', `${rev}:${REL}`); } catch { return null; } };
const sha = b => b && createHash('sha256').update(b).digest('hex');
const refuse = m => { console.error(`\npre-push: REFUSED - ${m}\n`); process.exit(1); };

const input = fs.readFileSync(0, 'utf8').trim();
for (const line of input ? input.split('\n') : []) {
  const [, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
  if (remoteRef !== 'refs/heads/main' || ZERO.test(localSha)) continue;
  let base = ZERO.test(remoteSha) ? null : remoteSha;
  if (base) { try { git('cat-file', '-e', base + '^{commit}'); } catch { base = null; } }
  if (!base) { try { git('rev-parse', '--verify', 'refs/remotes/origin/main'); base = 'refs/remotes/origin/main'; } catch { base = null; } }
  const next = sha(blob(localSha));
  if (!next) refuse(`${localSha.slice(0, 8)} has no ${REL}`);
  if (base && sha(blob(base)) === next) { console.error(`pre-push: ${REL} unchanged (${next.slice(0, 16)}); no internal check needed`); continue; }

  let url; try { url = git('config', 'kaswin.internalUrl').toString().trim(); } catch { refuse('git config kaswin.internalUrl is not set'); }
  const recordPath = path.join(repo, 'apps/kaswin-v2/test-results/deployed', next + '.json');
  let record; try { record = JSON.parse(fs.readFileSync(recordPath, 'utf8')); } catch {
    refuse(`page ${next.slice(0, 16)} has no internal check. Deploy it to ${url}, then run: node tools/check-deployed.mjs ${url}`);
  }
  if (record.passed !== true || record.servedSha256 !== next || record.url !== url) refuse(`internal check for ${next.slice(0, 16)} did not pass on ${url} (${recordPath})`);
  let live;
  try { live = sha(Buffer.from(await (await fetch(url, {cache: 'no-store'})).arrayBuffer())); } catch (e) { refuse(`cannot reach ${url}: ${e.message}`); }
  if (live !== next) refuse(`${url} now serves ${live.slice(0, 16)}, not the page being pushed (${next.slice(0, 16)}); re-deploy and re-check`);
  console.error(`pre-push: page ${next.slice(0, 16)} passed internal check at ${record.at} on ${url}; allowed`);
}
