const AttachmentFiles = (() => {
  function extract(data) {
    const found = new Map();
    const seen = new Set();
    const stack = [data];
    let visited = 0;
    while (stack.length) {
      const value = stack.pop();
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      if (++visited > 100000) throw new Transfer.Fault('API_CHANGED');
      seen.add(value);
      const fileId = Safety.id(value.file_id, true) || Safety.id(value.id, true);
      if (fileId) {
        const rawName = [value.filename, value.file_name, value.name].find(n => typeof n === 'string' && n.trim() && !/^(undefined|null|\[object Object\])(?:\.|$)/i.test(n));
        const record = Safety.file({ id: fileId, filename: rawName,
          expectedSize: [value.file_size_bytes, value.size_bytes, value.size].find(s => Safety.size(s) !== null),
          mime: value.mime_type || value.mimetype || value.mime }, found.size);
        if (!found.has(fileId)) found.set(fileId, record);
        else {
          const previous = found.get(fileId);
          if (rawName && previous.filename.startsWith('chatgpt-file-')) previous.filename = record.filename;
          previous.expectedSize ??= record.expectedSize;
          previous.mime ??= record.mime;
        }
      }
      const values = Object.values(value);
      for (let i = values.length - 1; i >= 0; i--) if (values[i] && typeof values[i] === 'object') stack.push(values[i]);
    }
    return [...found.values()];
  }
  function isListShape(data) {
    if (Array.isArray(data)) return true;
    if (!data || typeof data !== 'object') return false;
    // Recognize empty collection envelopes, but reject error objects masquerading as empty scans.
    return ['files', 'items', 'data', 'attachments', 'results'].some(key =>
      Array.isArray(data[key]) || (data[key] && typeof data[key] === 'object' && isListShape(data[key])));
  }
  async function scan(client, conversationId, signal) {
    const all = new Map();
    const visitedPages = new Set();
    let page = null;
    let partial = false;
    for (let index = 0; index < Config.MAX_PAGES; index++) {
      Transfer.aborted(signal);
      const url = Endpoints.list(conversationId, page);
      if (visitedPages.has(url)) { partial = true; break; }
      visitedPages.add(url);
      const data = await client.request(url, signal, async response => {
        if (/html/i.test(response.headers.get('content-type') || '')) throw new Transfer.Fault('HTML_RESPONSE');
        try { return await response.json(); } catch (error) {
          if (signal.aborted || error.name === 'AbortError') throw error;
          throw new Transfer.Fault('API_CHANGED');
        }
      });
      const records = extract(data);
      if (!records.length && !isListShape(data)) throw new Transfer.Fault('API_CHANGED');
      let added = 0;
      for (const record of records) if (!all.has(record.id)) { all.set(record.id, record); added++; }
      const next = Endpoints.nextPage(data, records.length);
      partial = next.partial;
      if (all.size > Config.MAX_FILES || (index > 0 && !added && next.page)) { partial = true; break; }
      if (!next.page) break;
      if (index === Config.MAX_PAGES - 1) { partial = true; break; }
      page = next.page;
    }
    return { files: [...all.values()].slice(0, Config.MAX_FILES), partial };
  }
  function html(prefix, mime) {
    return /(?:text\/html|application\/xhtml\+xml)/i.test(mime) ||
      /^\s*(?:\uFEFF)?\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(prefix.replace(/^(?:\s*<!--[\s\S]*?-->)+/, ''));
  }
  async function inspect(response) {
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (html('', mime)) throw new Transfer.Fault('HTML_RESPONSE');
    const blob = await response.blob();
    if (!blob.size) throw new Transfer.Fault('EMPTY_RESPONSE');
    const prefix = await blob.slice(0, 1024).text();
    if (html(prefix, mime)) throw new Transfer.Fault('HTML_RESPONSE');
    if (blob.size <= Config.MAX_METADATA_BYTES && (mime.includes('json') || /^\s*\{/.test(prefix))) {
      let parsed;
      try { parsed = JSON.parse(await blob.text()); } catch { /* A JSONL or ordinary text attachment. */ }
      if (parsed && !Array.isArray(parsed) && typeof parsed === 'object' && Object.hasOwn(parsed, 'download_url')) {
        // Malformed metadata is an error, never a tiny JSON file saved as a PDF.
        const url = Endpoints.safeDownload(parsed.download_url);
        return { metadata: { url: url.href, filename: parsed.file_name,
          expectedSize: Safety.size(parsed.file_size_bytes) } };
      }
    }
    return { blob, mime };
  }
  async function checkMagic(blob, filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const bytes = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
    const begins = signature => signature.every((b, i) => bytes[i] === b);
    let valid = true;
    if (ext === 'pdf') valid = new TextDecoder().decode(bytes).includes('%PDF-');
    if (ext === 'png') valid = begins([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (['jpg', 'jpeg'].includes(ext)) valid = begins([0xff, 0xd8, 0xff]);
    if (['docx', 'xlsx', 'pptx', 'zip'].includes(ext)) {
      // Encrypted Office documents may use OLE; generic ZIP files may be empty.
      valid = begins([0x50, 0x4b, 0x03, 0x04]) || begins([0x50, 0x4b, 0x05, 0x06]) ||
        begins([0x50, 0x4b, 0x07, 0x08]) || (ext !== 'zip' && begins([0xd0, 0xcf, 0x11, 0xe0]));
    }
    if (!valid) throw new Transfer.Fault('MAGIC_MISMATCH');
  }
  async function resolve(client, conversationId, file, signal, onProgress = () => {}) {
    for (let integrityAttempt = 0; integrityAttempt < 2; integrityAttempt++) {
      let url = Endpoints.download(conversationId, file.id);
      let filename = file.filename;
      let expectedSize = file.expectedSize;
      let result;
      for (let hops = 0; ; hops++) {
        Transfer.aborted(signal);
        onProgress('resolving');
        result = await client.request(url, signal, async response => {
          onProgress('downloading');
          const length = Number(response.headers.get('content-length'));
          if (length > Config.LARGE_FILE_BYTES) onProgress('large');
          return inspect(response);
        });
        if (!result.metadata) break;
        if (hops >= Config.MAX_METADATA_HOPS) throw new Transfer.Fault('TOO_MANY_HOPS');
        onProgress('metadata');
        url = result.metadata.url;
        if (typeof result.metadata.filename === 'string' && result.metadata.filename.trim()) filename = Safety.filename(result.metadata.filename, filename);
        if (result.metadata.expectedSize !== null) expectedSize = result.metadata.expectedSize;
        if (expectedSize > Config.LARGE_FILE_BYTES) onProgress('large');
      }
      Transfer.aborted(signal);
      if (expectedSize !== null && result.blob.size !== expectedSize) {
        if (!integrityAttempt) { onProgress('size_retry'); continue; }
        throw new Transfer.Fault('SIZE_MISMATCH', { expected: expectedSize, actual: result.blob.size });
      }
      await checkMagic(result.blob, filename);
      Transfer.aborted(signal);
      return { blob: result.blob, filename, expectedSize, actualSize: result.blob.size,
        mime: result.mime, verified: expectedSize !== null };
    }
  }
  return Object.freeze({ extract, isListShape, scan, inspect, resolve, html, checkMagic });
})();
