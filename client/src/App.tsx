import { lazy, Suspense } from 'react';
import { CodexErrorBoundary } from '@/components/codex/CodexErrorBoundary';
import { CodexMobileApp } from '@/components/codex/CodexMobileApp';

const WorkbenchApp = lazy(() => import('@/workbench/WorkbenchApp'));

function shouldRenderWorkbench() {
  const pathName = window.location.pathname.replace(/\/+$/, '') || '/';
  if (pathName === '/chat' || pathName.startsWith('/chat/')) return false;
  if (pathName === '/workbench' || pathName.startsWith('/workbench/')) return true;
  return window.location.hostname.toLowerCase().startsWith('app-code-ai.');
}

export default function App() {
  const workbench = shouldRenderWorkbench();
  return (
    <CodexErrorBoundary>
      {workbench ? (
        <Suspense fallback={<div className="flex h-dvh items-center justify-center bg-[#f6f7f8] text-sm text-slate-500">טוען את Code‑AI Workbench…</div>}>
          <WorkbenchApp />
        </Suspense>
      ) : (
        <CodexMobileApp />
      )}
    </CodexErrorBoundary>
  );
}
