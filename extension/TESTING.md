# Verification report — 2026-10-28

## Executed in the build environment

`npm run build`, `npm run check`, and `npm test` passed. The automated Node suite contains **39 passing tests** with no skipped tests. It includes a 75-file batch.

The static checks validate Manifest V3, version, narrow permissions, every referenced asset, JavaScript syntax, external popup scripts, and absence of dynamic code or raw debug logging. The security review searched source for authorization, Bearer, cookie, token, download_url, console calls, Chrome storage, and postMessage. Every live persistence and message path reconstructs allowed data; errors are fixed categories.

| Behavior | Executed verification |
| --- | --- |
| Direct bytes and metadata → PDF | Actual Response/Blob processing with synthetic HTTP responses |
| Four metadata hops and a rejected fifth | Unit tests |
| HTML by MIME, prefix, BOM, case, comment | Rejection tests; no save callback invoked by controller |
| Legitimate small JSON and JSONL | Exact byte/text equality checks |
| Zero-byte response and malformed metadata | Rejected before handoff |
| Size mismatch | Exactly one complete re-resolution retry; expected/actual reported |
| Signatures | PDF/PNG/JPEG/Office/ZIP checks; unknown types allowed |
| Filename safety | Missing/undefined names, paths, reserved device names, multibyte length, duplicates |
| 429 / Retry-After | Four bounded retries, numeric/date parsing, abortable backoff |
| 401 / 403 / 404 / 5xx / network | Distinct categories and bounded/no-retry behavior as appropriate |
| Stop during fetch, backoff, inter-file delay | Aborts promptly; no next file/retry launched |
| 75 attachments | Maximum concurrent fetches: one; 74 configured inter-file delays |
| Resume and Retry failed | Completed files skipped; explicit selection permits redownload |
| Token refresh and late 401 | Newest credential used; old request cannot erase new context |
| Fetch coexistence | Receiver, arguments, exact promise identity, synchronous errors preserved |
| MAIN/content/worker/popup request path | Source scripts executed in separate VM realms with simulated Chrome APIs |
| Repeated script initialization | One wrapper, one command handler, one download |
| Popup closure | Controller completes without popup ownership or keepalive messages; new status query restores live state |
| SPA push/replace and save-time URL guard | Old batch canceled; stale files cleared; fresh scan required |
| Persistent history | Saved success restored after fresh scan; no old credential restored |
| Privacy | Synthetic secrets absent from emitted messages, storage records, logs, diagnostics |
| External signed URL | Empty captured headers, omitted credentials/referrer, blocked HTTP redirects |
| Message sender validation | Foreign extension/page control commands rejected by worker |

## Not executed successfully here

**Real Chromium rendering and extension loading remain unverified in this environment.** Playwright was available, but no browser binary was installed. Its Chromium installer returned a non-ZIP response, and the system package installer was unavailable because of container permission restrictions. These failures are not counted as passing tests. The VM messaging tests simulate Chrome APIs and do not substitute for a real browser.

`tests/browser.mjs` is provided as a reproducible Chromium fixture test. It uses a new temporary profile and synthetic credentials, intercepts every network route, loads `extension/`, drives the actual popup, checks saved bytes, and exercises popup closure, rate-limit stop, SPA navigation, and reload history. It also captures light/dark popup screenshots when run. This script has been syntax-checked but **not successfully executed** in the build environment.

**No live signed-in ChatGPT conversation was tested.** Internal route availability, current production response schemas, real CORS/CSP behavior, per-account headers, and Chrome multiple-download prompts need a live smoke test. The internal routes were implemented from the user-provided, previously working workflow; they are not represented as a stable public API.

## Manual smoke test after installation

1. Load `extension/` in Chrome; confirm its card has no manifest errors. Reload a ChatGPT conversation and check Auth ready.
2. Scan a known conversation and compare the filenames with the attachments you expect. Review any partial-list warning.
3. Download a PDF and open it. Check that a small JSON or JSONL file retains its contents. Compare a size-verified file’s size in Chrome Downloads.
4. Start a multi-file batch and allow multiple downloads. Close and reopen the popup. Verify progress continues.
5. Stop partway through, then Resume. Confirm completed files are skipped.
6. Navigate to another conversation. Confirm the old job stops and the list clears. Return, scan, and confirm prior successes are restored.
7. If a file shows a failure, inspect the inline reason and retry that file. Check actual saves in Chrome Downloads, since handoff is not disk confirmation.
8. Export diagnostics and inspect the small JSON: it should have only version, readiness, counts, and error categories.

Testing does not require users to reveal authentication or open DevTools. Never paste tokens, raw request headers, or signed download links into reports.
