import path from 'node:path';

const MARKER = '# code-ai-static-extension-panel:v1';

/** Keep the extension shell in the same immutable release as /assets and the
 * ordinary shell. The API process may intentionally remain on an older build. */
export function withStaticExtensionPanel(locations) {
  if (typeof locations !== 'string' || locations.includes(MARKER)) {
    throw new Error('Expected an unmodified static UI locations include');
  }
  if (/location\s*=\s*\/extension-panel(?:\/|\s|\{)/.test(locations)) {
    throw new Error('Remove the previous extension location before rendering');
  }
  const index = /location\s*=\s*\/index\.html\s*\{\s*root\s+([^;]+);/.exec(locations);
  const assets = /location\s+\^~\s+\/assets\/\s*\{\s*root\s+([^;]+);/.exec(locations);
  const publicRoot = index?.[1]?.trim();
  if (!publicRoot || publicRoot !== assets?.[1]?.trim()
    || !path.posix.isAbsolute(publicRoot) || /[\s;{}$"'\\]/.test(publicRoot)) {
    throw new Error('The index and asset locations must share one literal absolute public root');
  }
  return locations.trimEnd() + `

${MARKER}
# Deliberately no X-Frame-Options here. Only this shell permits an extension
# parent; ordinary pages retain their existing SAMEORIGIN protection.
location = /extension-panel {
    root ${publicRoot};
    try_files /index.html =404;
    add_header Content-Security-Policy "frame-ancestors 'self' chrome-extension:" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Cache-Control "no-store, no-cache, must-revalidate" always;
    add_header Pragma "no-cache" always;
}
location = /extension-panel/ {
    return 308 /extension-panel$is_args$args;
    add_header Cache-Control "no-store" always;
    add_header Content-Security-Policy "frame-ancestors 'self' chrome-extension:" always;
    add_header X-Content-Type-Options "nosniff" always;
}
`;
}
