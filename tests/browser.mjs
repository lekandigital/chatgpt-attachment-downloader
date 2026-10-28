// Optional integration test using actual Chromium + the built unpacked extension.
// Every network request is intercepted; no real ChatGPT account or profile is used.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
let playwright;
try { playwright = await import('playwright'); }
catch {
  if (!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) throw new Error('Run npm install, then npx playwright install chromium.');
  playwright = await import(pathToFileURL(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright/index.mjs')).href);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), 'cad-browser-fixture-'));
const results = path.join(root, 'test-results');
await mkdir(results, { recursive: true });
const extension = path.join(root, 'extension');
let context;
try {
  context = await playwright.chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    ...(process.env.CAD_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CAD_CHROMIUM_EXECUTABLE } : {}),
  });
  const requests = [], pageErrors = [], downloads = [];
  const files = [
    { id: 'file_direct', filename: 'direct.pdf' },
    { id: 'file_two_stage', filename: 'deck.pdf' },
    { id: 'file_html', filename: 'bad.pdf' },
    { id: 'file_json', filename: 'notes.json' },
    { id: 'file_jsonl', filename: 'transcript.jsonl' },
    { id: 'file_dup1', filename: 'same.txt' },
    { id: 'file_dup2', filename: 'same.txt' },
  ];
  const pdf = '%PDF-1.7\nfixture PDF content\n%%EOF';
  const jsonBody = JSON.stringify({ contents: 'ordinary attachment', number: 42 });
  const jsonlBody = '{"line":1}\n{"line":2}\n';
  let hold = false;
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    requests.push({ url: request.url(), headers: request.headers() });
    const fulfill = (body, contentType = 'application/octet-stream', extra = {}) => route.fulfill({ status: 200, body, contentType, ...extra });
    if (url.origin === 'https://chatgpt.com') {
      if (url.pathname === '/fixture.js') return fulfill(`fetch('/backend-api/me',{headers:{Authorization:'Bearer SYNTHETIC_BROWSER_ONLY','oai-device-id':'FIXTURE_DEVICE'}});`, 'application/javascript');
      if (url.pathname === '/backend-api/me') return fulfill('{}', 'application/json');
      if (url.pathname.includes('/conversations/')) return fulfill(JSON.stringify({ files, has_more: false }), 'application/json');
      if (url.pathname.includes('/files/download/file_two_stage')) return fulfill(JSON.stringify({
        download_url: 'https://files.oaiusercontent.com/fixture.pdf?sig=SIGNED_FIXTURE', file_name: 'real-deck.pdf', file_size_bytes: Buffer.byteLength(pdf),
      }), 'application/json');
      if (url.pathname.includes('/files/download/file_html')) return fulfill('<!DOCTYPE html><html>ChatGPT shell</html>', 'text/html');
      if (url.pathname.includes('/files/download/file_jsonl')) return fulfill(jsonlBody, 'application/jsonl');
      if (url.pathname.includes('/files/download/file_json')) return fulfill(jsonBody, 'application/json');
      if (url.pathname.includes('/files/download/file_direct')) {
        if (hold) return route.fulfill({ status: 429, headers: { 'retry-after': '30' }, body: '' });
        return fulfill(pdf, 'application/pdf');
      }
      if (url.pathname.includes('/files/download/')) return fulfill('plain attachment', 'text/plain');
      if (url.pathname.startsWith('/c/')) return fulfill('<!doctype html><html><head><title>Attachment fixture - ChatGPT</title><script src="/fixture.js" defer></script></head><body><h1>Test conversation</h1></body></html>', 'text/html', {
        headers: { 'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self' https://files.oaiusercontent.com; style-src 'none'" },
      });
    }
    if (url.origin === 'https://files.oaiusercontent.com') return fulfill(pdf, 'application/pdf', { headers: { 'access-control-allow-origin': 'https://chatgpt.com' } });
    throw new Error(`Unexpected fixture request to ${url.origin}`);
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const chat = await context.newPage(); chat.on('pageerror', error => pageErrors.push(error.message));
  chat.on('download', download => downloads.push(download));
  await chat.goto('https://chatgpt.com/c/fixture-A');
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://chatgpt.com/c/fixture-A' }))[0].id);
  async function status() {
    return worker.evaluate(async id => chrome.tabs.sendMessage(id, { type: 'PAGE_COMMAND', command: { type: 'GET_STATUS' } }, { frameId: 0 }), tabId);
  }
  async function waitFor(check, label) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) { const result = await status(); if (check(result.state)) return result.state; await new Promise(r => setTimeout(r, 100)); }
    throw new Error(label);
  }
  async function openPopup() {
    const popup = await context.newPage(); popup.on('pageerror', error => pageErrors.push(error.message));
    // Keep the fixture as active tab; extension pages opened in tabs otherwise select themselves.
    await worker.evaluate(async id => chrome.tabs.update(id, { active: true }), tabId);
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.locator('#auth').filter({ hasText: 'Auth ready' }).waitFor();
    return popup;
  }
  await waitFor(state => state.auth.detected, 'Authentication not observed at document_start');
  let popup = await openPopup();
  await popup.locator('#scan').click();
  await waitFor(state => state.scan.fresh && state.files.length === files.length, 'Scan failed');
  await popup.locator('#acknowledge').click();
  await popup.locator('#file-list .file-row').first().waitFor();
  await popup.screenshot({ path: path.join(results, 'popup-light.png') });
  await popup.emulateMedia({ colorScheme: 'dark' });
  await popup.screenshot({ path: path.join(results, 'popup-dark.png') });
  await popup.locator('#download-all').click();
  await popup.close();
  const done = await waitFor(state => state.batch.status === 'completed', 'Batch did not complete with popup closed');
  assert.equal(done.files.filter(f => f.status === 'downloaded').length, 6);
  assert.equal(done.files.find(f => f.id === 'file_html').error.code, 'HTML_RESPONSE');
  assert.equal(downloads.length, 6);
  const filenames = downloads.map(d => d.suggestedFilename());
  assert.equal(new Set(filenames).size, 6); assert.ok(filenames.includes('real-deck.pdf')); assert.ok(!filenames.includes('bad.pdf'));
  for (const download of downloads) {
    assert.equal(await download.failure(), null);
    const bytes = await readFile(await download.path());
    if (download.suggestedFilename().endsWith('.pdf')) assert.equal(bytes.toString(), pdf);
    if (download.suggestedFilename() === 'notes.json') assert.equal(bytes.toString(), jsonBody);
    if (download.suggestedFilename() === 'transcript.jsonl') assert.equal(bytes.toString(), jsonlBody);
  }
  const external = requests.filter(r => r.url.startsWith('https://files.oaiusercontent.com/'));
  assert.ok(external.length > 0);
  for (const request of external) for (const header of ['authorization', 'oai-device-id', 'cookie', 'referer']) assert.equal(request.headers[header], undefined);
  popup = await openPopup();
  await popup.locator('#phase').filter({ hasText: 'Completed' }).waitFor();
  // Deliberate redownload, then stop while Retry-After is active.
  hold = true;
  await popup.locator('#select-file_direct').check(); await popup.locator('#download-selected').click();
  await waitFor(state => state.waiting === 'rate_limit', 'Rate-limit state missing');
  await popup.locator('#stop').click(); await waitFor(state => state.batch.status === 'stopped', 'Stop failed');
  hold = false;
  await popup.close();
  await chat.evaluate(() => history.pushState({}, '', '/c/fixture-B'));
  const navigated = await waitFor(state => state.conversationId === 'fixture-B', 'SPA change not detected');
  assert.equal(navigated.files.length, 0); assert.equal(navigated.scan.fresh, false);
  await chat.goto('https://chatgpt.com/c/fixture-A');
  await waitFor(state => state.auth.detected && !state.scan.fresh, 'Reload did not reset auth/scan');
  popup = await openPopup(); await popup.locator('#scan').click();
  const restored = await waitFor(state => state.scan.fresh, 'Rescan failed');
  assert.ok(restored.files.some(f => f.status === 'downloaded'));
  const saved = await worker.evaluate(() => chrome.storage.local.get(null));
  const serialized = JSON.stringify(saved);
  for (const secret of ['SYNTHETIC_BROWSER_ONLY', 'FIXTURE_DEVICE', 'SIGNED_FIXTURE', 'Bearer', 'authorization', 'download_url']) assert.ok(!serialized.includes(secret));
  assert.deepEqual(pageErrors, []);
  console.log('Chromium fixture passed: manifest load, real messaging, popup, CSP, byte downloads, popup closure, stop/backoff, SPA, persistence, header scoping.');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
