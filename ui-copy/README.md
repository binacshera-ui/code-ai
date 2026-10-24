# CODE-AI UI-only copy

This site uses the **original** CODE-AI React app (`client/src/App.tsx`), original chat and Workbench components, original styles and original public assets. There are no visual overrides: colors, layout, spacing, typography and controls come directly from the original client.

`preview-main.tsx` installs `previewApi.ts` before importing the original app. The local transport returns synthetic demo sessions and profile data; no request is forwarded to a backend. All non-GET requests return 403. The preview entry does not register the production service worker. NGINX also returns 404 for `/api/*` and `/sw.js`, and the document CSP blocks all network connections (`connect-src 'none'`). The original account data, real conversations, sending, uploads, notifications and other server-backed actions are deliberately unavailable.

The static copy is served at `https://app-codex-2.bina-cshera.co.il`; the original `app-codex.bina-cshera.co.il` is separate and unchanged. The app's original routes and responsive behavior are preserved, including `/session/:profile/:id`, `/chat` and `/workbench`. Screens that require server data show fixture data or an unavailable state, not invented functionality.

Build: copy this package together with the adjacent `client/` and `shared/` source trees into an isolated build directory, then run `pnpm test && pnpm build`. Production artifacts are built by BEAM (`node-package-v1`) and the attested `dist/` is published through the release symlink under `/srv/code-ai-ui-copy/`.
