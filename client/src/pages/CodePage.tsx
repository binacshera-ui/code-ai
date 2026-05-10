import { useState } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { logRequest, logResponse, logError, logWebhook } from '@/stores/logStore';
import { useSubmitGuard } from '@/lib/useSubmitGuard';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Code, Terminal, Pencil, BookOpen, Zap,
  Upload, Loader2, Send, FileCode, Play, Copy, Check
} from 'lucide-react';

const CODE_OPTIONS = [
  { id: 'super_agent', label: 'סוכן קוד', icon: Zap, description: 'סוכן מלא עם גישה לטרמינל ולריפו', price: 5 },
  { id: 'code_writer', label: 'כותב קוד', icon: Code, description: 'כתיבת קוד חדש לפי בקשה', price: 3 },
  { id: 'code_editor', label: 'עורך קוד', icon: Pencil, description: 'עריכת קבצי קוד מצורפים', price: 2 },
  { id: 'code_explainer', label: 'מסביר קוד', icon: BookOpen, description: 'הסבר קוד ומושגים תכנותיים', price: 1 },
];

interface CodeJob {
  id: string;
  option: string;
  input: string;
  code?: string;
  status: 'processing' | 'completed' | 'error';
  result?: string;
  error?: string;
  createdAt: Date;
}

export function CodePage() {
  const { user } = useAuthStore();
  const [selectedOption, setSelectedOption] = useState(CODE_OPTIONS[0].id);
  const [input, setInput] = useState('');
  const [code, setCode] = useState('');
  const [jobs, setJobs] = useState<CodeJob[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { beginSubmit, endSubmit } = useSubmitGuard();

  const handleSubmit = async () => {
    const trimmedInput = input.trim();
    const submittedCode = code.trim();
    const option = selectedOption;

    if (!trimmedInput) return;
    if (!user || isProcessing || !beginSubmit()) return;

    const job: CodeJob = {
      id: `code-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      option,
      input: trimmedInput,
      code: submittedCode || undefined,
      status: 'processing',
      createdAt: new Date(),
    };

    setJobs(prev => [job, ...prev]);
    setActiveJobId(job.id);
    setIsProcessing(true);

    const webhookPayload = {
      thread: { id: job.id },
      message: {
        from: { address: user.email },
        to: [{ address: 'code@example.com' }],
        subject: `קוד: ${CODE_OPTIONS.find(o => o.id === option)?.label}`,
        text: trimmedInput,
      },
      attachments: submittedCode ? [{
        fileName: 'code.txt',
        contentType: 'text/plain',
        content: submittedCode,
      }] : [],
      ai_analysis: {
        role: 'new_request',
        code_option: option,
      },
      source: 'web_ui',
    };

    logWebhook('/api/dashboard/code', webhookPayload);

    try {
      const startTime = Date.now();
      logRequest('/api/dashboard/code', 'POST', { option, inputLength: trimmedInput.length, hasCode: !!submittedCode });

      const response = await fetch('/api/dashboard/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: trimmedInput,
          code: submittedCode,
          option,
          email: user.email,
        }),
      });

      const data = await response.json();
      const duration = Date.now() - startTime;
      logResponse('/api/dashboard/code', response.status, data, duration);

      if (!response.ok) {
        throw new Error(data.error || 'שגיאה בעיבוד');
      }

      setJobs(prev => prev.map(j => 
        j.id === job.id 
          ? { ...j, status: 'completed', result: data.result || data.code || 'העיבוד הושלם' } 
          : j
      ));

      setInput('');
      setCode('');

    } catch (err: any) {
      logError('/api/dashboard/code', err);
      setJobs(prev => prev.map(j => 
        j.id === job.id 
          ? { ...j, status: 'error', error: err.message } 
          : j
      ));
    } finally {
      endSubmit();
      setIsProcessing(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const activeJob = jobs.find(j => j.id === activeJobId);
  const selectedOptionData = CODE_OPTIONS.find(o => o.id === selectedOption);

  return (
    <div className="p-6 h-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-xl flex items-center justify-center">
            <Code className="w-5 h-5 text-white" />
          </div>
          מתכנת
        </h1>
        <p className="text-slate-500 mt-2">עבודה עם קוד - סוכן מלא, כתיבה, עריכה והסבר</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" style={{ height: 'calc(100% - 100px)' }}>
        {/* Input Panel */}
        <div className="flex flex-col bg-white rounded-2xl border border-slate-200 p-4">
          {/* Options */}
          <div className="flex gap-2 mb-4 flex-wrap">
            {CODE_OPTIONS.map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.id}
                  onClick={() => setSelectedOption(option.id)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-all ${
                    selectedOption === option.id
                      ? 'bg-emerald-100 border border-emerald-300 text-emerald-700'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span className="text-sm">{option.label}</span>
                  <Badge className="bg-white/50 text-xs">{option.price}</Badge>
                </button>
              );
            })}
          </div>

          <p className="text-sm text-slate-500 mb-4">{selectedOptionData?.description}</p>

          {/* Request Input */}
          <label className="text-sm font-medium text-slate-700 mb-2">הבקשה שלך:</label>
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="תאר את מה שאתה צריך..."
            className="min-h-[100px] resize-none mb-4"
          />

          {/* Code Input */}
          {(selectedOption === 'code_editor' || selectedOption === 'code_explainer') && (
            <>
              <label className="text-sm font-medium text-slate-700 mb-2">קוד (אופציונלי):</label>
              <div className="relative flex-1 min-h-[150px]">
                <Textarea
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="הדבק את הקוד כאן..."
                  className="h-full font-mono text-sm resize-none"
                  dir="ltr"
                />
                <Badge className="absolute top-2 left-2 bg-slate-800 text-white text-xs">
                  קוד
                </Badge>
              </div>
            </>
          )}

          <Button
            onClick={handleSubmit}
            disabled={isProcessing || !input.trim()}
            className="mt-4 bg-gradient-to-r from-emerald-500 to-emerald-600"
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-4 h-4 ml-2 animate-spin" />
                מעבד...
              </>
            ) : (
              <>
                <Play className="w-4 h-4 ml-2" />
                הרץ
              </>
            )}
          </Button>
        </div>

        {/* Output Panel */}
        <div className="flex flex-col bg-slate-900 rounded-2xl border border-slate-700 overflow-hidden">
          {/* Terminal Header */}
          <div className="flex items-center gap-2 px-4 py-3 bg-slate-800 border-b border-slate-700">
            <Terminal className="w-4 h-4 text-emerald-400" />
            <span className="text-sm text-slate-300">פלט</span>
            {activeJob?.result && (
              <button
                onClick={() => copyToClipboard(activeJob.result!)}
                className="mr-auto flex items-center gap-1 px-2 py-1 text-xs bg-slate-700 text-slate-300 rounded hover:bg-slate-600"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                {copied ? 'הועתק!' : 'העתק'}
              </button>
            )}
          </div>

          {/* Terminal Content */}
          <ScrollArea className="flex-1 p-4">
            {jobs.length === 0 ? (
              <div className="text-slate-500 text-center py-8">
                <Terminal className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">הפלט יופיע כאן</p>
                <p className="text-xs mt-1">שלח בקשה כדי להתחיל</p>
              </div>
            ) : (
              <div className="space-y-4">
                {jobs.map((job) => (
                  <div 
                    key={job.id}
                    className={`p-3 rounded-lg cursor-pointer transition-colors ${
                      activeJobId === job.id 
                        ? 'bg-slate-800 border border-slate-600' 
                        : 'bg-slate-800/50 hover:bg-slate-800'
                    }`}
                    onClick={() => setActiveJobId(job.id)}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <Badge className={`text-xs ${
                        job.status === 'completed' ? 'bg-emerald-500/20 text-emerald-400' :
                        job.status === 'error' ? 'bg-red-500/20 text-red-400' :
                        'bg-amber-500/20 text-amber-400'
                      }`}>
                        {job.status === 'processing' ? 'מעבד...' :
                         job.status === 'completed' ? 'הושלם' : 'שגיאה'}
                      </Badge>
                      <span className="text-xs text-slate-500">
                        {CODE_OPTIONS.find(o => o.id === job.option)?.label}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 truncate">{job.input}</p>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>

          {/* Active Job Result */}
          {activeJob?.result && (
            <div className="border-t border-slate-700 p-4 max-h-[300px] overflow-y-auto">
              <pre className="text-sm text-emerald-300 font-mono whitespace-pre-wrap" dir="ltr">
                {activeJob.result}
              </pre>
            </div>
          )}
          
          {activeJob?.error && (
            <div className="border-t border-red-900/50 p-4 bg-red-900/20">
              <pre className="text-sm text-red-400 font-mono whitespace-pre-wrap">
                Error: {activeJob.error}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CodePage;
