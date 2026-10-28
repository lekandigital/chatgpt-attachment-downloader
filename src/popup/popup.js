const $ = id => document.getElementById(id);
let tabId = null;
let state = null;
let acknowledged = false;
let pendingAction = false;
let connected = false;
let storageError = false;
let localError = null;
let hideCompleted = false;
let listSignature = '';
const selected = new Set();
const LABELS = { pending: '○ Pending', resolving: '↻ Resolving', downloading: '↓ Downloading', downloaded: '✓ Downloaded',
  failed: '! Failed', stopped: '■ Stopped', rate_limited: '◷ Rate limited', skipped: '— Skipped' };
const LOGS = { CONVERSATION: 'Conversation detected', AUTH_READY: 'Authentication detected', AUTH_EXPIRED: 'Authentication waiting',
  SCAN_START: 'Scanning attachments', SCAN_DONE: 'Scan completed', BATCH_START: 'Batch started', FILE_SAVED: 'File handed to Chrome',
  METADATA: 'Resolved a file download link', RATE_LIMIT: 'Rate limited; waiting to retry', RETRY: 'Retrying request',
  STOPPED: 'Stopped', COMPLETED: 'Batch completed', SIZE_RETRY: 'Size mismatch; retrying once', ERROR: 'Request failed' };
function sizeLabel(size) {
  if (size === null || size === undefined) return 'Size unknown';
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}
function errorLabel(error) {
  if (!error) return '';
  let text = Safety.ERRORS[error.code] || Safety.ERRORS.UNEXPECTED;
  if (error.code === 'SIZE_MISMATCH') text += ` Expected: ${sizeLabel(error.expected)}. Received: ${sizeLabel(error.actual)}.`;
  return text;
}
function update(next) {
  const clean = Safety.state(next);
  if (!clean) return;
  if (state?.instanceId !== clean.instanceId || state?.conversationId !== clean.conversationId) { selected.clear(); hideCompleted = false; listSignature = ''; localError = null; }
  else if (state.revision > clean.revision) return;
  state = clean;
  const ids = new Set(state.files.map(file => file.id));
  for (const id of selected) if (!ids.has(id)) selected.delete(id);
}
async function send(message) {
  try { return await chrome.runtime.sendMessage(message); }
  catch { return { ok: false, error: { code: 'BRIDGE' } }; }
}
function visibleFiles() {
  const query = $('search').value.trim().toLowerCase();
  return (state?.files || []).filter(file => (!hideCompleted || file.status !== 'downloaded') && file.filename.toLowerCase().includes(query));
}
function renderFiles(busy) {
  const visible = visibleFiles();
  const signature = JSON.stringify([visible, [...selected], busy]);
  if (signature === listSignature) return;
  listSignature = signature;
  const list = $('file-list');
  const scroll = list.scrollTop;
  const focused = document.activeElement?.id;
  const fragment = document.createDocumentFragment();
  for (const file of visible) {
    const row = document.createElement('div'); row.className = 'file-row';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.id = `select-${file.id}`;
    checkbox.checked = selected.has(file.id); checkbox.disabled = busy;
    checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(file.id); else selected.delete(file.id); render(); });
    const info = document.createElement('div'); info.className = 'file-info';
    const label = document.createElement('label'); label.className = 'file-name'; label.htmlFor = checkbox.id; label.textContent = file.filename;
    const meta = document.createElement('div'); meta.className = 'file-meta';
    const detail = document.createElement('span');
    const extension = file.filename.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toUpperCase() || 'FILE';
    detail.textContent = `${extension} · ${sizeLabel(file.actualSize ?? file.expectedSize)}${file.verified ? ' · Verified' : ''}`;
    const status = document.createElement('span'); status.className = `file-status ${file.status === 'downloaded' ? 'success' : file.status === 'failed' ? 'failed' : ''}`;
    status.textContent = LABELS[file.status] || 'Pending';
    meta.append(detail, status); info.append(label, meta);
    if (file.error) {
      const reason = document.createElement('p'); reason.className = 'file-reason'; reason.textContent = errorLabel(file.error); info.append(reason);
    }
    row.append(checkbox, info); fragment.append(row);
  }
  list.replaceChildren(fragment); list.scrollTop = scroll;
  if (focused?.startsWith('select-')) document.getElementById(focused)?.focus({ preventScroll: true });
  $('empty-list').hidden = visible.length > 0;
  $('empty-list').textContent = state?.files.length ? 'No files match this view.' : 'No attachments found in this conversation.';
}
function render() {
  const files = state?.files || [];
  const busy = state?.batch.status === 'running' || state?.scan.status === 'scanning';
  const ready = connected && !!state?.auth.detected && !!state?.conversationId;
  const scanned = state?.scan.fresh === true;
  const downloaded = files.filter(file => file.status === 'downloaded').length;
  const failed = files.filter(file => file.status === 'failed').length;
  const remaining = files.length - downloaded - failed;
  const canDownload = ready && scanned && acknowledged && !busy && !pendingAction;
  $('auth').textContent = state?.auth.detected ? '● Auth ready' : state?.auth.expired ? '○ Auth expired' : '○ Auth waiting';
  $('auth').className = `pill ${state?.auth.detected ? 'ready' : ''}`;
  $('conversation').textContent = state?.conversationId ? state.title || 'ChatGPT conversation' : tabId ? 'No conversation detected' : 'Open a ChatGPT conversation';
  $('conversation-id').textContent = state?.conversationId ? `${state.conversationId.slice(0, 8)}…${state.conversationId.slice(-4)}` : '';
  $('connection-note').textContent = !tabId ? 'Open a conversation at chatgpt.com, then click this extension.' : !connected ? Safety.ERRORS.BRIDGE :
    !state?.conversationId ? 'Navigate to a conversation to scan its attachments.' : !state.auth.detected ? errorLabel({ code: state.auth.expired ? 'AUTH_EXPIRED' : 'AUTH_WAITING' }) : '';
  $('reload').hidden = !tabId || (connected && !!state?.auth.detected) || busy;
  $('notice').hidden = acknowledged || !tabId;
  $('scan').disabled = !ready || busy || pendingAction;
  $('download-all').hidden = busy;
  $('download-all').disabled = !canDownload || !files.some(f => ['pending', 'failed', 'stopped'].includes(f.status));
  $('stop').hidden = !busy;
  $('stop').disabled = false;
  $('progress-section').hidden = !state || (!scanned && !busy && state.batch.status === 'idle');
  $('phase').textContent = state?.waiting === 'rate_limit' ? 'Rate limited' : state?.scan.status === 'scanning' ? 'Scanning' :
    ({ running: 'Downloading', stopped: 'Stopped', paused: 'Authentication paused', completed: failed ? 'Completed with errors' : 'Completed', idle: 'Ready' }[state?.batch.status] || 'Ready');
  $('progress-count').textContent = `${downloaded + failed} / ${files.length} files`;
  $('progress').max = files.length || 1; $('progress').value = downloaded + failed;
  $('totals').textContent = `${downloaded} downloaded · ${failed} failed · ${remaining} remaining`;
  const active = files.find(file => file.id === state?.activeId);
  $('active-file').textContent = active ? `${active.filename} · ${sizeLabel(active.expectedSize)}` : '';
  const countdown = state?.retryAt ? Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000)) : 0;
  $('countdown').textContent = state?.retryAt ? `${state.waiting === 'rate_limit' ? 'Rate limited. ' : ''}Retrying in ${countdown}s…` : '';
  const error = localError || (storageError ? { code: 'STORAGE' } : state?.error);
  $('error').hidden = !error; $('error').textContent = errorLabel(error);
  $('partial').hidden = !state?.scan.partial;
  $('partial').textContent = `${files.length} attachments returned. Additional attachments may exist; the API did not provide a usable next page.`;
  $('large-file').hidden = !state?.largeFile || !busy;
  $('attachments').hidden = !scanned && !files.length;
  $('file-count').textContent = `${files.length} found`;
  $('selected-count').textContent = selected.size ? `${selected.size} selected` : '';
  $('download-selected').disabled = !canDownload || !selected.size;
  $('download-selected').textContent = files.some(f => selected.has(f.id) && f.status === 'downloaded') ? 'Download selected again' : 'Download selected';
  $('resume').disabled = !canDownload || !files.some(f => ['pending', 'stopped', 'failed'].includes(f.status));
  $('retry-failed').disabled = !canDownload || !failed;
  for (const id of ['select-all', 'select-none', 'select-failed']) $(id).disabled = busy;
  $('clear-completed').textContent = hideCompleted ? 'Show completed' : 'Hide completed';
  $('handoff-note').hidden = !files.length;
  $('forget').disabled = busy;
  $('export').disabled = !state;
  renderFiles(busy);
  const lines = (state?.logs || []).map(log => `${new Date(log.at).toLocaleTimeString()}  ${log.error ? errorLabel(log.error) : LOGS[log.code] || 'Status updated'}`);
  $('log').textContent = lines.join('\n'); $('log').style.whiteSpace = 'pre-wrap';
}
async function command(type) {
  if (!tabId || (!state && type !== 'GET_STATUS')) return;
  pendingAction = true; localError = null; render();
  const result = await send({ type: 'UI_COMMAND', tabId, command: { type, conversationId: state?.conversationId,
    ...(type === 'DOWNLOAD_SELECTED' ? { ids: [...selected] } : {}) } });
  if (result.state) update(result.state);
  if (!result.ok) localError = result.error || { code: 'BRIDGE' };
  storageError = result.storageError === true;
  pendingAction = false; render();
}
for (const [id, type] of Object.entries({ scan: 'SCAN_FILES', 'download-all': 'START_DOWNLOADS', stop: 'STOP_DOWNLOADS',
  'download-selected': 'DOWNLOAD_SELECTED', resume: 'RESUME', 'retry-failed': 'RETRY_FAILED' })) $(id).addEventListener('click', () => { void command(type); });
$('select-all').addEventListener('click', () => { visibleFiles().forEach(file => selected.add(file.id)); render(); });
$('select-none').addEventListener('click', () => { selected.clear(); render(); });
$('select-failed').addEventListener('click', () => { selected.clear(); visibleFiles().filter(f => f.status === 'failed').forEach(f => selected.add(f.id)); render(); });
$('clear-completed').addEventListener('click', () => { hideCompleted = !hideCompleted; render(); });
$('search').addEventListener('input', render);
$('acknowledge').addEventListener('click', async () => { const result = await send({ type: 'ACK_DOWNLOADS' }); acknowledged = result.ok; render(); });
$('reload').addEventListener('click', async () => { await send({ type: 'RELOAD_PAGE', tabId }); window.close(); });
$('forget').addEventListener('click', async () => {
  const result = await send({ type: 'CLEAR_HISTORY' });
  $('privacy-result').textContent = result.ok ? 'Saved history cleared. Open tabs may save new progress when their state changes.' : 'Saved history could not be cleared.';
});
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(Safety.diagnostics(state), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = 'attachment-downloader-diagnostics.json';
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});
async function poll() {
  if (tabId && !pendingAction) {
    const result = await send({ type: 'UI_COMMAND', tabId, command: { type: 'GET_STATUS' } });
    connected = !!result.ok;
    if (result.state) update(result.state);
    storageError = result.storageError === true;
    render();
  }
  setTimeout(poll, 900);
}
void (async () => {
  const view = await send({ type: 'OPEN_VIEW' });
  tabId = view.tabId ?? null; acknowledged = view.acknowledged === true;
  render(); await poll();
})();
