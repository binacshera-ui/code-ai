import { CodexErrorBoundary } from '@/components/codex/CodexErrorBoundary';
import { CodexMobileApp } from '@/components/codex/CodexMobileApp';

export default function App() {
  return (
    <CodexErrorBoundary>
      <CodexMobileApp />
    </CodexErrorBoundary>
  );
}
