/* Real Chrome/WebGL integration check; no server or npm dependency required.
 * CHROME=/path/to/chrome node test/browser.test.js
 * Outputs screenshots under /tmp/watersim-*.png. Uses a temporary isolated
 * Chrome profile; does not touch the normal browser session. */
'use strict';
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const chromePath = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = fs.mkdtempSync('/tmp/watersim-chrome-');
const chrome = spawn(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  // crashpad/keychain touch user-level paths that are denied in sandboxed
  // sessions; disabling them keeps the headless run self-contained
  '--disable-crashpad', '--disable-breakpad',
  '--remote-debugging-port=9223', '--user-data-dir=' + profile, '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws;
const watchdog = setTimeout(() => { console.error('Browser test timed out'); chrome.kill(); process.exit(1); }, 300000);
chrome.on('error', error => { console.error('Chrome launch error', error); process.exitCode = 1; });
(async () => {
  console.log('Starting Chrome WebGL validation…');
  let targets;
  for (let i = 0; i < 60; i++) {
    if (chrome.exitCode !== null) throw new Error('Chrome exited: ' + chrome.exitCode);
    try { targets = await (await fetch('http://127.0.0.1:9223/json')).json(); break; }
    catch (_) { await delay(100); }
  }
  assert(targets, 'Chrome DevTools endpoint available');
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map(), errors = [];
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const error = JSON.stringify(msg.params.exceptionDetails);
      errors.push(error); console.error('Browser exception:', error);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(msg.params.entry.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map(a => a.value || a.description || '').join(' '));
    }
  };
  function send(method, params = {}) {
    return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Page.navigate', { url: pathToFileURL(path.resolve(__dirname, '../index.html')).href });
  await delay(500);
  // Manual presets are the shipped default (Medium 40³): boot completes without
  // any auto calibration, so wait for the running sim, then opt into the
  // 50 FPS calibration explicitly.
  const waitBoot = () => evaluate(`new Promise((resolve,reject)=>{const start=performance.now(); function tick(){
    if(document.getElementById('loading').style.display==='none' && window.waterSimStats) return resolve(true);
    if(performance.now()-start>180000) return reject(new Error('Boot timeout')); requestAnimationFrame(tick); } tick(); })`);
  await waitBoot();
  console.log('Boot complete (manual Medium 40³ default, GPU solver off)');
  await evaluate(`document.getElementById('selRes').value='auto50';document.getElementById('selRes').dispatchEvent(new Event('change'));`);
  const waitCalibration = () => evaluate(`new Promise((resolve,reject)=>{const start=performance.now(); function tick(){
    if(window.waterSimPerformance && document.getElementById('loading').style.display==='none') return resolve(window.waterSimPerformance);
    if(document.getElementById('stQuality').textContent.includes('failed')) return reject(new Error('Calibration failed'));
    if(performance.now()-start>180000) return reject(new Error('Calibration timeout')); requestAnimationFrame(tick); } tick(); })`);
  const fifty = await waitCalibration();
  console.log('50 FPS calibration:', JSON.stringify(fifty));
  await evaluate(`new Promise(resolve=>{const start=performance.now();function tick(){if(performance.now()-start>=16000)return resolve();requestAnimationFrame(tick);}tick();})`);
  const live = await evaluate('window.waterSimStats');
  console.log('Live stats:', JSON.stringify(live));
  assert(live.vapor > 0 && live.nightVapor > live.vapor * 0.1, 'sustained atmosphere reaches shaded hemisphere');
  let shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/watersim-50.png', Buffer.from(shot.data, 'base64'));
  // Change display and interaction controls, then exercise the other budget.
  // Splash / drop-ball lost their buttons — trigger them via their keyboard
  // shortcuts (S / B), which the app still wires.
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'s'}));
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'b'}));
    document.getElementById('rangeAtm').value='0.65';document.getElementById('rangeAtm').dispatchEvent(new Event('input'));
    window.waterSimPerformance=null;document.getElementById('selRes').value='auto25';document.getElementById('selRes').dispatchEvent(new Event('change'));`);
  const twentyFive = await waitCalibration();
  console.log('25 FPS calibration:', JSON.stringify(twentyFive));
  await evaluate(`new Promise(resolve=>{let n=0;function tick(){if(++n>=120)return resolve();requestAnimationFrame(tick);}tick();})`);
  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/watersim-25.png', Buffer.from(shot.data, 'base64'));
  await evaluate(`document.getElementById('btnPause').click();document.getElementById('btnReset').click();`);
  await delay(100);
  assert.equal(await evaluate(`document.getElementById('loading').style.display`), 'none');
  assert.deepEqual(errors, [], 'No browser runtime or shader compilation errors');
  console.log('REAL BROWSER TEST PASSED; screenshots: /tmp/watersim-50.png, /tmp/watersim-25.png');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(watchdog);
  if (ws) ws.close();
  chrome.once('exit', () => {
    // Only remove the mkdtemp-owned test profile, never a normal Chrome profile.
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  });
  chrome.kill();
});
