import test from 'node:test';
import assert from 'node:assert/strict';
import { core, plain, json, authenticated } from './helpers.mjs';

test('nested extraction preserves order, deduplicates IDs, and keeps size/mime', () => {
  const { AttachmentFiles } = core();
  const files = AttachmentFiles.extract({ data: [{ file_id: 'file_one', name: 'notes.txt', size: 8 },
    { nested: { id: 'file_two', file_name: 'deck.pdf', mime_type: 'application/pdf' } },
    { id: 'file_one', filename: 'duplicate.txt' }, { id: 'not_a_file' }] });
  assert.equal(files.length, 2); assert.equal(files[0].filename, 'notes.txt');
  assert.equal(files[0].expectedSize, 8); assert.equal(files[1].mime, 'application/pdf');
});
test('missing, invalid, unsafe and reserved filenames are sanitized', () => {
  const { Safety } = core();
  for (const name of [undefined, null, {}, 'undefined', 'null', '[object Object]', 'undefined.html']) {
    assert.equal(Safety.filename(name, 'fallback.pdf'), 'fallback.pdf');
  }
  assert.equal(Safety.filename('../CON.pdf'), '_CON.pdf');
  assert.ok(!/[\/\\:]/.test(Safety.filename('../../foo:bar\\evil.pdf')));
  const long = Safety.filename('😀'.repeat(200) + '.pdf');
  assert.ok(Buffer.byteLength(long) <= 200); assert.ok(long.endsWith('.pdf'));
});
test('direct file bytes are accepted', async () => {
  const { AttachmentFiles } = core();
  const result = await AttachmentFiles.inspect(new Response('%PDF-1.7\nreal bytes', { headers: { 'content-type': 'application/pdf' } }));
  assert.equal(await result.blob.text(), '%PDF-1.7\nreal bytes');
});
test('two-stage PDF resolves actual bytes and checks metadata size', async () => {
  const modules = core();
  const bytes = '%PDF-1.7\nreal bytes';
  const calls = [];
  const client = modules.Transfer.create({ auth: authenticated(modules), guard() {}, fetcher: async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? json({ download_url: '/backend-api/estuary/content?id=SIGNED_PRIVATE', file_name: 'actual.pdf', file_size_bytes: bytes.length }) : new Response(bytes);
  } });
  const file = modules.Safety.file({ id: 'file_one', filename: 'wrong.txt' });
  const result = await modules.AttachmentFiles.resolve(client, 'A', file, new AbortController().signal);
  assert.equal(calls.length, 2); assert.equal(result.filename, 'actual.pdf'); assert.equal(result.verified, true);
  assert.equal(await result.blob.text(), bytes);
});
test('HTML is rejected by MIME, prefix, case, BOM and leading comment', async () => {
  const { AttachmentFiles } = core();
  for (const [body, type] of [['ordinary', 'text/html'], ['ordinary', 'application/xhtml+xml'], ['<!DOCTYPE html><html>app</html>', 'application/octet-stream'],
    ['  <HTML class="chatgpt-theme">bad', 'application/pdf'], ['\uFEFF<html>bad', 'text/plain'], ['<!-- comment -->\n<html>bad', 'application/octet-stream']]) {
    await assert.rejects(AttachmentFiles.inspect(new Response(body, { headers: { 'content-type': type } })), { code: 'HTML_RESPONSE' });
  }
});
test('legitimate JSON and JSONL retain their exact bytes', async () => {
  const { AttachmentFiles } = core();
  for (const text of [JSON.stringify({ message: 'x'.repeat(3000) }), '{"line":1}\n{"line":2}\n', '{"download_url_note":"not metadata"}']) {
    const result = await AttachmentFiles.inspect(new Response(text, { headers: { 'content-type': 'application/json' } }));
    assert.equal(await result.blob.text(), text);
  }
});
test('zero-byte and malformed metadata never become downloads', async () => {
  const { AttachmentFiles } = core();
  await assert.rejects(AttachmentFiles.inspect(new Response('')), { code: 'EMPTY_RESPONSE' });
  for (const value of [null, 'javascript:alert(1)', 'https://evil.example/path']) {
    await assert.rejects(AttachmentFiles.inspect(json({ download_url: value })), { code: 'UNSAFE_URL' });
  }
});
test('magic checks catch JSON mislabeled as PDF; arbitrary file types pass', async () => {
  const { AttachmentFiles } = core();
  await assert.rejects(AttachmentFiles.checkMagic(new Blob(['{"status":"success"}']), 'deck.pdf'), { code: 'MAGIC_MISMATCH' });
  await AttachmentFiles.checkMagic(new Blob(['anything']), 'notes.custom');
  await AttachmentFiles.checkMagic(new Blob([new Uint8Array([0x50, 0x4b, 0x05, 0x06])]), 'empty.zip');
});
test('size mismatch retries once and reports expected/actual without returning bytes', async () => {
  const { AttachmentFiles, Safety } = core();
  let calls = 0;
  const client = { request: async (url, signal, consume) => { calls++; return consume(calls % 2 ? json({ download_url: '/backend-api/estuary/content', file_size_bytes: 100 }) : new Response('tiny')); } };
  await assert.rejects(AttachmentFiles.resolve(client, 'A', Safety.file({ id: 'file_a', filename: 'a.txt' }), new AbortController().signal), { code: 'SIZE_MISMATCH', expected: 100, actual: 4 });
  assert.equal(calls, 4);
});
test('four metadata hops are allowed; a fifth is rejected', async () => {
  const { AttachmentFiles, Safety } = core();
  for (const allowed of [true, false]) {
    let calls = 0;
    const client = { request: async (url, signal, consume) => consume(++calls <= (allowed ? 4 : 5) ? json({ download_url: '/backend-api/estuary/content' }) : new Response('file')) };
    const task = AttachmentFiles.resolve(client, 'A', Safety.file({ id: 'file_a', filename: 'a.txt' }), new AbortController().signal);
    if (allowed) assert.equal(await (await task).blob.text(), 'file');
    else await assert.rejects(task, { code: 'TOO_MANY_HOPS' });
    assert.equal(calls, 5);
  }
});
test('recognized cursor and offset pagination are followed; uncertain lists show partial', async () => {
  const { AttachmentFiles, Endpoints } = core();
  const urls = [];
  const client = { request: async (url, signal, consume) => {
    urls.push(url);
    return consume(json(urls.length === 1 ? { files: [{ id: 'file_1', name: '1.txt' }], next_cursor: 'NEXT_PRIVATE' } : { files: [{ id: 'file_2', name: '2.txt' }], has_more: false }));
  } };
  const result = await AttachmentFiles.scan(client, 'A', new AbortController().signal);
  assert.equal(result.files.length, 2); assert.equal(result.partial, false);
  assert.ok(urls[1].includes('cursor=NEXT_PRIVATE'));
  assert.equal(Endpoints.nextPage({}, 200).partial, true);
  assert.equal(Endpoints.nextPage({ has_more: true, next: '/unknown' }, 1).partial, true);
  assert.deepEqual(plain(Endpoints.nextPage({ pagination: { next_offset: 200 } }, 200).page), { kind: 'offset', value: 200 });
});
test('repeated pagination cursors stop without an infinite loop', async () => {
  const { AttachmentFiles } = core();
  let calls = 0;
  const result = await AttachmentFiles.scan({ request: async (url, signal, consume) => {
    calls++; return consume(json({ files: [{ id: 'file_1', name: 'a.txt' }], next_cursor: 'same' }));
  } }, 'A', new AbortController().signal);
  assert.equal(calls, 2); assert.equal(result.partial, true);
});
test('empty lists work; unexpected API objects are reported', async () => {
  const { AttachmentFiles } = core();
  const response = value => ({ request: (url, signal, consume) => consume(json(value)) });
  assert.equal((await AttachmentFiles.scan(response({ files: [] }), 'A', new AbortController().signal)).files.length, 0);
  await assert.rejects(AttachmentFiles.scan(response({ error: 'changed' }), 'A', new AbortController().signal), { code: 'API_CHANGED' });
});
