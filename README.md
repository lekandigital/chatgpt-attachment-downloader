# ChatGPT Attachment Downloader

A personal, unpacked Chrome extension for downloading attachments from **the ChatGPT conversation you currently have open**. It scans on demand and downloads one file at a time, with a 1.5-second pause between files. Version 1.0.0. Not affiliated with or endorsed by OpenAI.

## Install — no coding or build step needed

1. Extract the ZIP. Keep the extracted folder somewhere permanent; Chrome loads the extension from that folder.
2. In Chrome, enter `chrome://extensions` in the address bar.
3. Turn on **Developer mode** at the upper right.
4. Click **Load unpacked**.
5. Select the **`extension` folder inside `chatgpt-attachment-downloader`**. This is the folder containing `manifest.json`, `main-world.js`, and `popup`.
6. Pin **ChatGPT Attachment Downloader** using Chrome’s puzzle-piece menu if you want easy access.
7. **Reload any ChatGPT tab that was open before installation.** The extension needs to observe a normal authenticated page request. No DevTools or token copying is needed.

Chrome 111 or newer is required. Only `https://chatgpt.com/*` is supported. Chrome Web Store publication is not required. To remove the extension, click **Remove** on its card in `chrome://extensions`.

## Use

1. Open a conversation at `https://chatgpt.com/c/...` (project and custom-GPT conversation paths containing `/c/` also work).
2. Click the extension. Wait for **Auth ready**.
3. Click **Scan attachments** and review the list.
4. Acknowledge the one-time notice about Chrome allowing multiple downloads.
5. Click **Download all**, or check specific files and click **Download selected**.
6. If Chrome asks whether ChatGPT may download multiple files, choose **Allow**.

Downloads use your Chrome download folder and settings. They are separate original files, not one combined ZIP. Closing the popup does not stop the batch. **Keep the ChatGPT tab open and on the same conversation.** A sleeping or discarded tab may interrupt processing.

**“Downloaded” means validated bytes were handed to Chrome.** Because this version uses page-created Blob links rather than the Downloads API, it cannot confirm disk completion, identify browser-blocked downloads, or detect a canceled Save dialog. Check Chrome’s Downloads (`chrome://downloads`). If a file was blocked or canceled, explicitly select it and use **Download selected again**.

## Stop, resume, and retry

- **Stop** immediately aborts the current network request or retry wait. Already handed-off files remain completed; unstarted files stay pending. It cannot cancel a file Chrome has already accepted.
- **Resume** processes pending, stopped, and failed files, skipping completed files.
- **Retry failed** processes failed files only.
- Selecting a completed file explicitly allows another download, with a distinct filename.
- Search filters filenames. Selection actions apply to visible rows; **Select none** clears all selections. **Hide completed** only hides rows and retains their completion history.

Navigating to another conversation stops the current batch, clears the visible list, and requires a fresh scan. After a full reload, scan again: locally saved successes for that conversation are restored and skipped. Credentials are never restored from storage. Saved progress covers the eight most recently scanned conversations, up to 5,000 records each; running a batch on one tab at a time is recommended.

## What is included

| Path | Purpose |
| --- | --- |
| `extension/` | Built extension, ready for Load unpacked |
| `extension/manifest.json` | Manifest V3, version 1.0.0 |
| `src/` | Readable source modules, manifest source, and popup HTML/CSS |
| `scripts/` | Dependency-free build, local icon generation, static checks |
| `tests/` | Unit tests, separate-realm messaging tests, and Chromium fixture test |
| `PRIVACY.md` | Privacy policy |
| `SECURITY.md` | Trust boundaries and credential handling |
| `TESTING.md` | Verification results and remaining manual checks |

## Architecture and private authentication

The MAIN-world script installs at `document_start` and passively observes the page’s existing authenticated `fetch` calls to ChatGPT’s `/backend-api/` routes. It does not call a login endpoint or ask you for a credential. It keeps a narrow allowlist of reusable headers **only in a private JavaScript closure inside the page**. Fresh observed requests replace the in-memory context; unloading the page clears it.

The wrapper delegates to the fetch implementation already installed, preserving its receiver, arguments, promise identity, and exceptions. It does not read request bodies, mutate page requests, or replace other extensions’ wrappers with a stale native reference.

Authenticated listing, link resolution, byte fetching, validation, and Blob saving all happen in MAIN. The isolated content script accepts only fixed commands and projects the resulting state into an explicit schema. The worker validates senders, routes commands, and stores sanitized file progress. The popup displays that state and owns no running job. Closing the popup or suspending the extension worker does not end the page’s work.

The only permissions are **storage**, **activeTab**, and the **ChatGPT host permission**. There is no cookies, history, tabs, scripting, webRequest, downloads, or all-sites permission. Declarative MAIN/isolated scripts avoid a scripting permission. `activeTab` identifies the tab you invoke the popup on; the ChatGPT host permission supports injection and routing only on ChatGPT pages.

**The extension does not send analytics. It does not upload conversation data. Authentication credentials are kept only in volatile page memory. Credentials are never persisted in extension storage.** There are no runtime dependencies, remote scripts, external fonts, CDN assets, telemetry, or developer servers. It sends requests only to ChatGPT and recognized file-storage URLs returned by ChatGPT. See `SECURITY.md` for the MAIN-world trust boundary: page scripts can interfere with a MAIN-world controller, so this is not isolation from a compromised ChatGPT page or a malicious extension.

## Download safeguards

- The initial response may be bytes or metadata containing `download_url`. Only metadata with a usable URL is followed, for at most four hops. The metadata itself is never saved as the attachment.
- Ordinary JSON/JSONL without `download_url` is preserved exactly. An invalid reserved `download_url` field fails closed.
- HTML MIME types and HTML document prefixes are rejected. This intentionally blocks genuine HTML attachments too.
- A zero-byte response is rejected. Known PDF, PNG, JPEG, and Office/ZIP signatures receive an additional check. Unrecognized file types are supported without a signature requirement.
- Metadata size, or list size if available, is compared with actual bytes. A mismatch retries from stage 1 once, then fails without saving. “Verified” means size matched, not a cryptographic checksum or malware scan.
- Filenames are normalized, path characters and reserved device names removed, and missing names replaced with safe fallbacks. Secret-like names or email addresses are redacted. Extensions are preserved. Batch duplicate names get suffixes; Chrome handles existing files on disk with its normal download behavior.
- Credentials and custom account headers are attached only to same-origin ChatGPT backend requests. External storage receives no captured headers or cookies, and no referrer.
- Automatic HTTP redirects are blocked to prevent account-header forwarding. Metadata hops are followed explicitly, with a fresh decision about which headers may be used.
- External destinations are restricted to `*.oaiusercontent.com` and recognized `sdmntpr*` / `oaisdmntpr*` Azure or S3 delivery hosts. Unknown hosts fail safely. This allowlist is in `src/core/endpoints.js`.
- Requests are sequential. There are four rate-limit retries, three server-error retries, and two network retries per request, with abortable waits. A 120-second timeout includes response-body transfer. Large files may need that configurable limit raised.
- `Retry-After` seconds or dates are honored, otherwise the delay increases through 30, 60, 90, and 120 seconds. There is no background polling of ChatGPT endpoints. The popup’s status polling is local message passing only.
- A 401 pauses the batch. It resumes only when you click Resume after a fresh page credential is observed. A 403 or 404 fails that file while allowing other files to proceed.

## Pagination and internal API changes

This version implements the internal routes supplied in the build specification:

```text
/backend-api/conversations/{conversationId}/files?limit=200
/backend-api/files/download/{fileId}?check_context_scopes_for_conversation_id={conversationId}&download_intent=true
```

It recursively extracts `file_id` or `id` values beginning with `file_` (also tolerating `file-`) and associated filename, size, and MIME metadata. It preserves response order and deduplicates by file ID.

Recognized `next_cursor` and `next_offset` envelopes are followed. Repeated cursors and repeated pages stop safely. Unknown continuation schemas, a full 200-record page without a completion signal, or the 50-page/5,000-file cap produce a visible partial-list warning. It does not guess arbitrary next URLs or claim a partial list is complete.

**These routes are internal implementation details, not a supported public OpenAI API. They can change.** Route construction and pagination parsing are centralized in `src/core/endpoints.js`; extraction is in `src/core/files.js`. This extension handles files returned by that list endpoint. It does not crawl the account or scrape every conversation, and it cannot recover expired or unauthorized files.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Auth waiting / reload to connect | Reload the ChatGPT tab once after installation; let the conversation finish loading. The page must use an authenticated fetch request the observer can see. |
| Authentication expired / 401 | Wait for a normal fresh ChatGPT request and then Resume. Or reload, scan again, and Resume. Do not copy tokens. |
| Rate limited / 429 | Leave the tab open for the displayed backoff, or Stop. After retry exhaustion, retry later. Do not repeatedly reload or click retry. |
| No attachments found | Confirm you are on the intended conversation. The API may not expose every generated artifact or sandbox link. An empty list is not an error. |
| Progress says downloaded, but files are missing | Check Chrome’s Downloads and site permission for automatic/multiple downloads. Select blocked files explicitly to download again. |
| A Save dialog appears for every file | Chrome’s “Ask where to save each file” setting applies to this extension too. |
| HTML response / API changed | The route may now return a login page or app shell, or the list schema changed. Nothing is saved under a false filename. |
| Network/CORS/page policy error | The browser may block the returned storage host or request. This extension does not weaken CSP, use a proxy, or add broad host permissions. |
| Unsupported destination | ChatGPT may be using a new storage host; inspect and update the centralized allowlist before rebuilding. |
| Size mismatch | The file was not saved after its one integrity retry. Retry later or download it manually in ChatGPT. |
| Request timed out | Large or slow files may exceed the per-request timeout. Raise `REQUEST_TIMEOUT_MS` in `src/core/config.js` and rebuild if needed. |
| Another extension is installed | Existing fetch/history wrappers are preserved. Unrelated ad-blocker telemetry errors are ignored. No need to disable other extensions without evidence they block attachment requests. |
| API schema changed | Update `endpoints.js` / `files.js` and rebuild. Diagnostics contain only counts and error categories. Never paste credentials into an issue. |

## Develop and verify

Node.js 20+ is needed only to edit/build/test the source. No installation is needed for the normal build or unit tests:

```sh
npm run build
npm run check
npm test
```

The build concatenates named closure modules into four isolated bundles. It contains no dynamic code generation, eval, package fetch, or runtime imports. Icon PNGs are generated from local geometry. Reload the extension’s card in `chrome://extensions` and reload ChatGPT after rebuilding.

For the optional real-browser fixture test:

```sh
npm install
npx playwright install chromium
npm run build
npm run test:browser
```

The browser fixture uses a fresh temporary Chromium profile, synthetic credentials, and intercepted ChatGPT routes. It never uses your signed-in Chrome profile. Consult `TESTING.md` for which checks were actually executed in this delivery.

Relevant primary documentation: [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [manifest execution worlds](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts), [Chrome messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging), [Playwright extension tests](https://playwright.dev/docs/chrome-extensions).
