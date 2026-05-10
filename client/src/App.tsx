import { AppDashboard } from '@/components/dashboard/AppDashboard';
import { CodexErrorBoundary } from '@/components/codex/CodexErrorBoundary';
import { CodexMobileApp } from '@/components/codex/CodexMobileApp';

function shouldUseCodexMobile() {
  const host = window.location.hostname;
  const params = new URLSearchParams(window.location.search);
  const configuredHost = String(import.meta.env.VITE_CODE_AI_HOSTNAME || '').trim().toLowerCase();

  if (configuredHost && host.toLowerCase() === configuredHost) {
    return true;
  }

  if (params.get('app') === 'codex' || params.get('app') === 'code-ai') {
    return true;
  }

  return window.location.pathname.startsWith('/codex');
}

export default function App() {
  if (!shouldUseCodexMobile()) {
    return <AppDashboard />;
  }

  return (
    <CodexErrorBoundary>
      <CodexMobileApp />
    </CodexErrorBoundary>
  );
}
