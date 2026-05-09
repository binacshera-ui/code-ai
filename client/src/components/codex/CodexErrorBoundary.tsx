import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { reportCodexClientLog } from '@/components/codex/codexCrashLogger';

interface CodexErrorBoundaryProps {
  children: ReactNode;
}

interface CodexErrorBoundaryState {
  hasError: boolean;
}

export class CodexErrorBoundary extends Component<CodexErrorBoundaryProps, CodexErrorBoundaryState> {
  state: CodexErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): CodexErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportCodexClientLog({
      type: 'react-error-boundary',
      message: error.message || 'React render crash',
      stack: error.stack || null,
      details: {
        componentStack: info.componentStack,
      },
    });
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="flex h-dvh items-center justify-center bg-[#FAFAFA] px-6 font-sans text-slate-800">
        <div className="w-full max-w-md rounded-[28px] border border-slate-100 bg-white px-8 py-10 text-center shadow-[0_24px_80px_-56px_rgba(15,23,42,0.35)]">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-50 text-rose-600">
            <AlertTriangle className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-black text-slate-950">המסך נפל, אבל הלוג נשמר</h1>
          <p className="mt-4 text-sm leading-7 text-slate-600">
            שמרתי לוג קריסה בשרת כדי שנוכל לעקוב אחרי התקלה. אפשר לרענן את המסך ולהמשיך מאותה מערכת.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-6 inline-flex h-12 items-center justify-center gap-2 rounded-[18px] bg-slate-900 px-5 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            <RefreshCw className="h-4 w-4" />
            רענן את Codex
          </button>
        </div>
      </div>
    );
  }
}
