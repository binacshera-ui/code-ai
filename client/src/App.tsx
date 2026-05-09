import { AppDashboard } from '@/components/dashboard/AppDashboard';
import { CodexErrorBoundary } from '@/components/codex/CodexErrorBoundary';
import { CodexMobileApp } from '@/components/codex/CodexMobileApp';

function shouldUseCodexMobile() {
  const host = window.location.hostname;
  const params = new URLSearchParams(window.location.search);

  if (host === 'app-codex.bina-cshera.co.il') {
    return true;
  }

  if (params.get('app') === 'codex') {
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
