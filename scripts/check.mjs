import { readFile, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(manifest.version, version);
assert.ok((await readFile('src/core/config.js', 'utf8')).includes(`VERSION: '${version}'`), 'Config.VERSION must match package.json');
assert.deepEqual(manifest.permissions, ['storage', 'activeTab']);
assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
assert.equal(manifest.web_accessible_resources, undefined);
assert.equal(manifest.externally_connectable, undefined);
const paths = [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon), ...manifest.content_scripts.flatMap(s => s.js)];
for (const file of paths) await access(path.join('extension', file));
async function walk(directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...await walk(target)); else files.push(target);
  }
  return files;
}
for (const file of [...await walk('src'), ...await walk('extension'), ...await walk('scripts'), ...await walk('tests')]) {
  if (!/\.(m?js)$/.test(file)) continue;
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  if (!file.startsWith('src/') && !file.startsWith('extension/')) continue;
  const code = await readFile(file, 'utf8');
  assert.ok(!/\beval\s*\(|\bnew\s+Function\s*\(/.test(code), `${file}: dynamic code`);
  assert.ok(!/console\.(?:log|debug|info)\(/.test(code), `${file}: unsafe debug logging`);
}
const html = await readFile('extension/popup/popup.html', 'utf8');
assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'Inline script');
assert.ok(!/\son\w+=/i.test(html), 'Inline event handler');
assert.ok(!/https?:\/\//i.test(html), 'Remote resource in popup');
await access('extension/popup/popup.js'); await access('extension/popup/popup.css');
console.log('Manifest, referenced assets, syntax, permissions, and popup CSP checks passed.');
