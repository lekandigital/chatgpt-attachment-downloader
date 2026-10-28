// All data crossing a world, UI, or storage boundary is explicitly projected here.
// Raw Error messages, API responses, headers, and URLs never cross those boundaries.
const Safety = (() => {
  const ERRORS = Object.freeze({
    AUTH_WAITING: 'Waiting for an authenticated ChatGPT request. Reload this tab once if needed.',
    AUTH_EXPIRED: 'Authentication expired. Wait for a fresh ChatGPT request, or reload and scan again.',
    HTTP_403: 'Access denied for this attachment.',
    HTTP_404: 'Attachment unavailable or endpoint changed.',
    HTTP_429: 'Rate limit retries exhausted. Try again later.',
    HTTP_5XX: 'ChatGPT is temporarily unavailable. Try again later.',
    HTTP_OTHER: 'The attachment request was rejected.',
    NETWORK: 'Network, CORS, or page security policy blocked the request.',
    TIMEOUT: 'The request timed out. You can retry this file.',
    HTML_RESPONSE: 'Received ChatGPT HTML instead of the attachment.',
    EMPTY_RESPONSE: 'Received a zero-byte response.',
    SIZE_MISMATCH: 'Size mismatch. The file was not saved.',
    TOO_MANY_HOPS: 'Too many download redirects.',
    UNSAFE_URL: 'The download destination is unsupported or unsafe.',
    API_CHANGED: "ChatGPT’s attachment API may have changed.",
    INVALID_FILE: 'This attachment is not in the current scan.',
    MAGIC_MISMATCH: 'The file contents do not match the expected file type.',
    SCAN_REQUIRED: 'Scan this conversation before downloading.',
    CONVERSATION_CHANGED: 'Conversation changed. Scan the new conversation.',
    NO_CONVERSATION: 'Open a ChatGPT conversation first.',
    BUSY: 'An operation is already running.',
    STOPPED: 'Stopped.',
    STORAGE: 'Progress could not be saved. Keep this tab open.',
    BRIDGE: 'Reload this ChatGPT tab to connect the extension.',
    UNEXPECTED: 'An unexpected error occurred. Stop and try again.',
  });
  const FILE_STATUSES = new Set(['pending', 'resolving', 'downloading', 'downloaded', 'failed', 'stopped', 'rate_limited', 'skipped']);
  const BATCH_STATUSES = new Set(['idle', 'running', 'stopped', 'paused', 'completed']);
  const SCAN_STATUSES = new Set(['idle', 'scanning', 'completed', 'failed', 'stopped']);
  const LOG_CODES = new Set(['CONVERSATION', 'AUTH_READY', 'AUTH_EXPIRED', 'SCAN_START', 'SCAN_DONE', 'BATCH_START', 'FILE_SAVED', 'METADATA', 'RATE_LIMIT', 'RETRY', 'STOPPED', 'COMPLETED', 'SIZE_RETRY', 'ERROR']);
  const SENSITIVE = /bearer|authorization|token|secret|cookie|session|password|api[_-]?key/i;
  function text(value, limit = 240) {
    if (typeof value !== 'string') return '';
    if (SENSITIVE.test(value)) return '[redacted]';
    return value
      .replace(/https?:\/\/\S+/gi, '[URL removed]')
      .replace(/[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email removed]')
      .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '')
      .slice(0, limit);
  }
  function id(value, file = false) {
    return typeof value === 'string' && !SENSITIVE.test(value) &&
      (file ? /^file[_-][A-Za-z0-9_-]{1,180}$/ : /^[A-Za-z0-9_-]{1,128}$/).test(value) ? value : null;
  }
  function conversation(url) {
    try {
      const parsed = new URL(url);
      return parsed.origin === Config.ORIGIN ? id(parsed.pathname.match(/\/c\/([^/?#]+)/)?.[1]) : null;
    } catch { return null; }
  }
  function size(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
  function count(value) { return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1000000) : 0; }
  function filename(value, fallback = 'chatgpt-file') {
    let name = typeof value === 'string' ? value.trim() : '';
    if (!name || /^(undefined|null|\[object Object\])(?:\.|$)/i.test(name)) name = fallback;
    const extension = name.match(/\.[A-Za-z0-9]{1,12}$/)?.[0] || '';
    name = text(name, 1000);
    if (name === '[redacted]') name = `redacted-file${extension}`;
    name = name.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    if (!name) name = 'chatgpt-file';
    // Keep filenames below common 255-byte limits, retaining the extension.
    const ext = name.match(/\.[A-Za-z0-9]{1,12}$/)?.[0] || '';
    let base = ext ? name.slice(0, -ext.length) : name;
    const encoder = new TextEncoder();
    while (encoder.encode(base + ext).length > 200) base = Array.from(base).slice(0, -1).join('');
    return base + ext;
  }
  function error(value) {
    if (!value || !Object.hasOwn(ERRORS, value.code)) return { code: 'UNEXPECTED' };
    const result = { code: value.code };
    if (value.code === 'SIZE_MISMATCH') {
      result.expected = size(value.expected);
      result.actual = size(value.actual);
    }
    return result;
  }
  function file(value, index = 0) {
    if (!value || !id(value.id, true)) return null;
    return {
      id: value.id,
      filename: filename(value.filename, `chatgpt-file-${index + 1}-${value.id}`),
      expectedSize: size(value.expectedSize), actualSize: size(value.actualSize),
      mime: typeof value.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(value.mime) ? value.mime.slice(0, 100) : null,
      status: FILE_STATUSES.has(value.status) ? value.status : 'pending',
      attempts: count(value.attempts), error: value.error ? error(value.error) : null,
      verified: value.verified === true, completedAt: size(value.completedAt),
    };
  }
  function files(values) {
    if (!Array.isArray(values)) return [];
    const seen = new Set();
    return values.slice(0, Config.MAX_FILES).map(file).filter(item => {
      if (!item || seen.has(item.id)) return false;
      seen.add(item.id); return true;
    });
  }
  function state(value) {
    if (!value || typeof value !== 'object') return null;
    return {
      instanceId: id(value.instanceId), conversationId: id(value.conversationId), title: text(value.title, 120),
      revision: count(value.revision),
      auth: { detected: value.auth?.detected === true, expired: value.auth?.expired === true },
      scan: { status: SCAN_STATUSES.has(value.scan?.status) ? value.scan.status : 'idle',
        fresh: value.scan?.fresh === true, lastScannedAt: size(value.scan?.lastScannedAt),
        partial: value.scan?.partial === true },
      files: files(value.files),
      batch: { status: BATCH_STATUSES.has(value.batch?.status) ? value.batch.status : 'idle',
        total: count(value.batch?.total), completed: count(value.batch?.completed),
        successful: count(value.batch?.successful), failed: count(value.batch?.failed),
        startedAt: size(value.batch?.startedAt), stoppedAt: size(value.batch?.stoppedAt) },
      activeId: id(value.activeId, true), retryAt: size(value.retryAt),
      waiting: ['rate_limit', 'retry'].includes(value.waiting) ? value.waiting : null,
      largeFile: value.largeFile === true,
      error: value.error ? error(value.error) : null,
      logs: Array.isArray(value.logs) ? value.logs.slice(-60).filter(l => LOG_CODES.has(l?.code)).map(l => ({
        at: size(l.at), code: l.code, error: l.error ? error(l.error) : null,
      })) : [],
    };
  }
  function history(value) {
    const clean = state(value);
    if (!clean?.conversationId) return null;
    // Authentication readiness is deliberately not restored across documents.
    return { conversationId: clean.conversationId, files: clean.files, lastScannedAt: clean.scan.lastScannedAt };
  }
  function diagnostics(value) {
    const clean = state(value);
    const statuses = {};
    for (const item of clean?.files || []) statuses[item.status] = (statuses[item.status] || 0) + 1;
    return { extensionVersion: Config.VERSION, conversationDetected: !!clean?.conversationId,
      authDetected: !!clean?.auth.detected, fileCount: clean?.files.length || 0, statuses,
      errors: (clean?.files || []).filter(f => f.error).map(f => ({ category: f.error.code })) };
  }
  return Object.freeze({ ERRORS, text, id, conversation, size, count, filename, error, file, files, state, history, diagnostics });
})();
