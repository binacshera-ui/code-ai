# Static UI and extension entry-point contract

The browser bridge and the embedded CODE-AI application are separate loads.
An online extension is not evidence that the application iframe booted.

When NGINX owns static files while the singleton API keeps running, its
versioned UI include must own `/`, `/index.html`, conversation routes,
`/extension-panel`, `/sw.js`, and `/assets/`. All shells must reference the same
immutable frontend release. Do not proxy the panel to the API process's older
`public/index.html`. Do not disguise an absent hashed asset as a successful SPA
response or disable browser MIME validation.

## Prepare

For an existing static include whose `/index.html` and `/assets/` locations
share a literal absolute root, use `withStaticExtensionPanel(locations)` from
`deploy/code-ai/static-ui-locations.mjs`. It preserves the input include,
including any independently released API proxies, and adds the panel shell
with the same root. It rejects mismatched roots or a duplicate panel location.
Already-qualified includes should retain their managed panel block on updates.

Remove the legacy exact `/extension-panel` block from the enclosing server
configuration in the same configuration transaction. Preserve a private backup
of both the enclosing configuration and previous include pointer. Keep both
until post-switch acceptance passes. Do not restart the application or its
queue merely to update static routing.

Only the panel shell omits `X-Frame-Options`; it sends
`Content-Security-Policy: frame-ancestors 'self' chrome-extension:`. Ordinary
shell routes must retain `X-Frame-Options: SAMEORIGIN`. Shells use `no-store`;
hashed assets remain immutable. The trailing-slash panel URL redirects to its
canonical path and preserves the query string.

## Qualify, then activate

1. Test the new include with an isolated NGINX configuration on an unused
   loopback port, using the real static files and MIME map. Never overlap API
   workers or point a second application at the production queue.
2. Verify parent-directory traversal and file readability as the NGINX worker
   user, not just as the deploying user.
3. Run `node scripts/check-ui-entrypoints.mjs http://127.0.0.1:PORT`.
4. Check that the accepted site/include has not changed concurrently. Activate
   the new include and enclosing configuration together, run `nginx -t`, and
   only then gracefully reload. Restore the captured configuration on failure.
5. Run the same entry-point check against the public origin. It must compare
   equal shell hashes and receive HTTP 200 with the correct CSS/JavaScript MIME.
6. In a real browser, reload the panel application and verify its composer and
   `code-ai:extension-ready` handshake, plus no new bundle/MIME/frame errors.
   Do not claim a native Side Panel test when only a normal tab was tested.

Read-only gate:

```bash
node scripts/check-ui-entrypoints.mjs https://your-code-ai-origin.example
```

Focused regression tests:

```bash
node --test scripts/ui-entrypoints.test.mjs
node --experimental-vm-modules --test scripts/personal-chrome-panel-profile.test.mjs scripts/personal-chrome-panel-pairing.test.mjs
```

The gate does not submit messages, touch queue state, clear caches, unpair
devices, or authenticate on behalf of the operator. It is not a full product QA.
