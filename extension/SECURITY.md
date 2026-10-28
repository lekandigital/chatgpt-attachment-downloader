# Security and trust boundaries

## Credential lifecycle

`Authentication.create()` in `src/core/auth.js` is instantiated only inside the MAIN bundle’s private IIFE. It copies only a narrow set of reusable authentication/account headers from the most recent same-origin backend fetch. RequestInit header overrides use the browser’s replacement semantics. Body content is never read or cloned.

Content type/length, trace IDs, baggage, request IDs, cookies, and one-time request proof headers are not replayed. The current allowlist is explicit, not a blacklist. If an endpoint later requires a new header, it must be added deliberately after understanding its purpose.

The popup, content script, and worker never receive a captured Headers object. Authentication readiness is a boolean; the token is not sent through postMessage, Chrome messaging, storage, log strings, export files, filenames, or URLs. The only outgoing use of the captured credential is the intended HTTPS request to the ChatGPT backend.

401 invalidation is versioned, so an older in-flight request cannot erase a newly observed credential. Downloader-initiated fetches delegate to the pre-installation fetch implementation and are not themselves observed as fresh page authentication.

## Network scope

Only current-conversation list and current-scan file IDs are accepted. Selected IDs must exist in the fresh scan. All requests use GET. There is no arbitrary URL, arbitrary code, proxy, cross-account, cookie-export, or whole-account crawling interface.

Signed metadata URLs are parsed inside MAIN, validated against HTTPS, credential-free URLs, same-origin backend paths or recognized file-storage hosts, then fetched with origin-appropriate headers. External requests use empty captured headers, `credentials: omit`, and `referrerPolicy: no-referrer`.

All HTTP redirects use `redirect: error`. Unlike Authorization, custom account headers may not be automatically removed on a cross-origin redirect; this version refuses that ambiguity. Metadata URL hops are followed explicitly and capped at four. Unknown hosts fail closed. A new delivery host or an HTTP-redirect-only route may therefore require an update.

The page’s CSP and CORS apply to MAIN fetches. The extension does not bypass them. No broad host permissions or background-fetch fallback are used.

## Message boundaries

The MAIN/content bridge checks event source, exact origin, namespace, request ID shape, command allowlist, conversation ID, and file ID shape. The content script and worker independently reconstruct state from explicit allowed fields; raw API objects and exceptions are never forwarded. Error strings are fixed local messages. Diagnostic exports further omit identifiers and filenames.

`window.postMessage` is **not a secret or authenticated channel**. The host page can see and forge same-window messages, including status data and the narrow commands. A MAIN-world script cannot provide cryptographic isolation from the page it runs inside. Namespace and random request IDs prevent accidents and correlate requests; they are not authentication. Command scope is limited to the open conversation and freshly scanned files. RESTORE_HISTORY only supplies prior statuses and cannot add downloadable IDs to a scan.

The isolated bridge does not turn page messages into arbitrary privileged extension calls. Only reconstructed progress is persisted. The worker accepts control commands only from its own popup URL, and state/history messages only from its own top-frame ChatGPT content script. No external-connectable or web-accessible resources are declared. The extension does not use a privileged Downloads API.

Other extensions that already intercept page fetches can see the requests they already wrap. This extension cannot protect against a malicious extension, compromised ChatGPT code, injected page scripts, a hostile browser, or an OS-level attacker. Do not interpret “kept in a closure” as isolation from those threats.

## Persistence and diagnostics

The worker applies `Safety.state` / `Safety.history` before every write and serializes writes to avoid stale completion regressions. Values are plain JSON records; no Blob, Request, Headers, AbortController, signed link, or credential is stored. Storage is local, not sync. Previous downloaded records are preserved across tabs; current UI state still reflects each live job.

Credential-like strings, JWT shapes, URLs, email addresses, control characters, and bidi controls are removed or redacted at display/storage boundaries. The only extension console error is the literal category `UNEXPECTED`, with no raw Error object. Diagnostics contain no filenames or identifiers.

## Download limits

All HTML and empty responses are rejected, including genuine HTML and empty attachments. A JSON object with a top-level `download_url` is treated as reserved download metadata; invalid destinations are rejected rather than saved as a disguised attachment. Other JSON and JSONL files are unchanged.

Successful status means bytes passed validation and a Blob anchor was clicked. It is not proof of disk completion. Chrome can still block multiple downloads, cancel a prompt, or encounter disk errors. Existing downloads can only be managed in Chrome’s own Downloads UI.

Requests, retry sleeps, and batch delays are abortable. Current-path checks are repeated before requests, after body reads, and synchronously just before save. Both history wrappers and a local pathname watcher handle SPA navigation. The watcher makes no network requests.

Report bugs with the diagnostics export and a description of the failure. Never include tokens, cookies, signed links, or raw request headers.
