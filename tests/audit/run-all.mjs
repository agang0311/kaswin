// Default: local JS only. VM requires explicit flags AND a reviewed binary manifest.
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const withVm = args[0] === '--vm';
if (args.length && !(args.length === 1 && args[0] === '--local') && !(withVm && args.length === 2 && args[1].startsWith('--manifest=') && path.isAbsolute(args[1].slice(11)))) {
  throw Error('Usage: run-all.mjs [--local | --vm --manifest=/absolute/reviewed.json]');
}
const suites = ['01-profile-and-templates.test.mjs', '02-fee-and-executor-binding.test.mjs', '03-timeout-and-timelock.test.mjs',
  '04-accepted-interpretation.test.mjs', '05-client-security.test.mjs', '07-runner-safety.test.mjs', '08-candidate-entrypoints.test.mjs']
  .map(file => ({file, args: ['--test', path.join(DIR, file)], timeout: 120000}));
if (withVm) suites.push({file: '06-vm-execution-suite.mjs', args: [path.join(DIR, '06-vm-execution-suite.mjs'), '--vm', args[1]], timeout: 1800000});
console.log(`Scope: local JS${withVm ? ' + explicit SCRIPT_VM' : ' only; VM NOT_RUN'}. Not budget calibration, network acceptance or a security certification.`);
const summary = [];
for (const s of suites) {
  const result = await new Promise(resolve => {
    const group = process.platform !== 'win32';
    const cp = spawn(process.execPath, s.args, {stdio: 'inherit', detached: group}); let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {if (group && cp.pid) process.kill(-cp.pid, 'SIGKILL'); else cp.kill('SIGKILL');} catch (e) {if (e.code !== 'ESRCH') cp.kill('SIGKILL');}
    }, s.timeout);
    cp.once('error', e => {clearTimeout(timer); resolve({passed: false, infrastructureError: e.code ?? 'SPAWN_ERROR'});});
    cp.once('close', (code, signal) => {clearTimeout(timer); resolve({passed: code === 0 && !signal && !timedOut, code, signal, timedOut});});
  });
  summary.push({suite: s.file, ...result});
  if (!result.passed) break; // do not start VM after local failure
}
console.log(JSON.stringify({scope: 'BOUNDED_TESTS_ONLY', summary}, null, 2));
if (summary.some(s => !s.passed) || summary.length !== suites.length) process.exitCode = 1;
