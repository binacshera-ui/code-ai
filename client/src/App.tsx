import { CodexErrorBoundary } from '@/components/codex/CodexErrorBoundary';
import { CodexMobileApp } from '@/components/codex/CodexMobileApp';
import { GeminiObservatoryApp } from '@/features/gemini-observatory/GeminiObservatoryApp';

export default function App() {
  return (
    <CodexErrorBoundary>
      {window.location.pathname.startsWith('/gemini-observatory')
        ? <GeminiObservatoryApp />
        : <CodexMobileApp />}
    </CodexErrorBoundary>
  );
}
