import { useState, useRef } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { logRequest, logResponse, logError, logWebhook } from '@/stores/logStore';
import { useSubmitGuard } from '@/lib/useSubmitGuard';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  FileEdit, Search, BookOpen, Languages, Eye, 
  Upload, Loader2, Send, FileText, AlignRight
} from 'lucide-react';

const EDIT_OPTIONS = [
  { id: 'torah_search_fast', label: 'חיפוש מקורות מהיר', icon: Search, description: 'שליפת מראה מקום מדויק', price: 2, category: 'תורני' },
  { id: 'torah_article', label: 'מאמר תורני', icon: BookOpen, description: 'כתיבת מאמר מסודר עם מקורות', price: 8, category: 'תורני' },
  { id: 'torah_semantic', label: 'חיפוש סמנטי', icon: Search, description: 'חיפוש לפי משמעות במאגר ספריא', price: 3, category: 'תורני' },
  { id: 'edit_torah', label: 'עריכה תורנית', icon: FileEdit, description: 'עריכה בסגנון תורני מדויק', price: 3, category: 'עריכה' },
  { id: 'edit_general', label: 'עריכה כללית', icon: FileEdit, description: 'עריכת טקסטים בכל סגנון', price: 2, category: 'עריכה' },
  { id: 'nikud', label: 'ניקוד', icon: AlignRight, description: 'ניקוד טקסט עברי עם הגהה', price: 2, category: 'עריכה' },
  { id: 'translate', label: 'תרגום', icon: Languages, description: 'תרגום בין שפות עם הגהה', price: 3, category: 'עריכה' },
  { id: 'ocr', label: 'OCR חכם', icon: Eye, description: 'חילוץ טקסט מתמונות ו-PDF', price: 2, category: 'עיבוד' },
  { id: 'python_processing', label: 'עיבוד נתונים', icon: FileText, description: 'ניתוח קבצים, גרפים, תרשימים', price: 4, category: 'עיבוד' },
];

interface EditJob {
  id: string;
  option: string;
  input: string;
  fileName?: string;
  status: 'processing' | 'completed' | 'error';
  result?: string;
  error?: string;
  createdAt: Date;
}

export function EditPage() {
  const { user } = useAuthStore();
  const [selectedOption, setSelectedOption] = useState(EDIT_OPTIONS[0].id);
  const [input, setInput] = useState('');
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [jobs, setJobs] = useState<EditJob[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { beginSubmit, endSubmit } = useSubmitGuard();

  const handleSubmit = async () => {
    const trimmedInput = input.trim();
    const option = selectedOption;
    const submittedFile = uploadedFile;

    if (!trimmedInput && !submittedFile) return;
    if (!user || isProcessing || !beginSubmit()) return;

    const job: EditJob = {
      id: `edit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      option,
      input: trimmedInput,
      fileName: submittedFile?.name,
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
        to: [{ address: 'edit@example.com' }],
        subject: `עריכה: ${EDIT_OPTIONS.find(o => o.id === option)?.label}`,
        text: trimmedInput,
      },
      attachments: submittedFile ? [{
        fileName: submittedFile.name,
        contentType: submittedFile.type,
        fileSize: submittedFile.size,
      }] : [],
      ai_analysis: {
        role: 'new_request',
        edit_option: option,
      },
      source: 'web_ui',
    };

    logWebhook('/api/dashboard/edit', webhookPayload);

    try {
      const startTime = Date.now();
      logRequest('/api/dashboard/edit', 'POST', { option, inputLength: trimmedInput.length });

      const formData = new FormData();
      formData.append('input', trimmedInput);
      formData.append('option', option);
      formData.append('email', user.email);
      if (submittedFile) {
        formData.append('file', submittedFile);
      }

      const response = await fetch('/api/dashboard/edit', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();
      const duration = Date.now() - startTime;
      logResponse('/api/dashboard/edit', response.status, data, duration);

      if (!response.ok) {
        throw new Error(data.error || 'שגיאה בעיבוד');
      }

      setJobs(prev => prev.map(j => 
        j.id === job.id 
          ? { ...j, status: 'completed', result: data.result || 'העיבוד הושלם בהצלחה' } 
          : j
      ));

      setInput('');
      setUploadedFile(null);

    } catch (err: any) {
      logError('/api/dashboard/edit', err);
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

  const categories = [...new Set(EDIT_OPTIONS.map(o => o.category))];
  const selectedOptionData = EDIT_OPTIONS.find(o => o.id === selectedOption);
  const activeJob = jobs.find(j => j.id === activeJobId);

  return (
    <div className="p-6 h-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-amber-500 to-amber-600 rounded-xl flex items-center justify-center">
            <FileEdit className="w-5 h-5 text-white" />
          </div>
          אומן הכתב
        </h1>
        <p className="text-slate-500 mt-2">עיבוד טקסט מתקדם - מקורות תורניים, עריכה, תרגום ועוד</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6" style={{ height: 'calc(100% - 100px)' }}>
        {/* Options Sidebar */}
        <div className="lg:col-span-1 bg-white rounded-2xl border border-slate-200 p-4 overflow-y-auto">
          {categories.map((category) => (
            <div key={category} className="mb-4">
              <h3 className="text-xs font-bold text-slate-400 uppercase mb-2">{category}</h3>
              <div className="space-y-1">
                {EDIT_OPTIONS.filter(o => o.category === category).map((option) => {
                  const Icon = option.icon;
                  return (
                    <button
                      key={option.id}
                      onClick={() => setSelectedOption(option.id)}
                      className={`w-full flex items-center gap-2 p-2 rounded-lg text-right transition-all text-sm ${
                        selectedOption === option.id
                          ? 'bg-amber-50 border border-amber-300 text-amber-700'
                          : 'hover:bg-slate-50 text-slate-600'
                      }`}
                    >
                      <Icon className="w-4 h-4 flex-shrink-0" />
                      <span className="flex-1 truncate">{option.label}</span>
                      <span className="text-xs text-slate-400">{option.price}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Input Area */}
        <div className="lg:col-span-2 flex flex-col bg-white rounded-2xl border border-slate-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-slate-800">
              {selectedOptionData?.label}
            </h3>
            <Badge className="bg-amber-100 text-amber-700 border-0">
              {selectedOptionData?.price} בינס'
            </Badge>
          </div>
          
          <p className="text-sm text-slate-500 mb-4">{selectedOptionData?.description}</p>

          {/* File Upload */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={(e) => e.target.files?.[0] && setUploadedFile(e.target.files[0])}
            className="hidden"
          />
          
          {uploadedFile ? (
            <div className="flex items-center gap-2 p-3 bg-amber-50 rounded-lg mb-3">
              <FileText className="w-5 h-5 text-amber-600" />
              <span className="flex-1 text-sm truncate">{uploadedFile.name}</span>
              <button
                onClick={() => setUploadedFile(null)}
                className="text-slate-400 hover:text-red-500"
              >
                ×
              </button>
            </div>
          ) : (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-center gap-2 p-3 border-2 border-dashed border-slate-300 rounded-lg hover:border-amber-400 transition-colors mb-3"
            >
              <Upload className="w-5 h-5 text-slate-400" />
              <span className="text-sm text-slate-500">העלה קובץ (Word, PDF, תמונה)</span>
            </button>
          )}

          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="הכנס את הטקסט או הבקשה שלך כאן..."
            className="flex-1 min-h-[200px] resize-none"
          />

          <Button
            onClick={handleSubmit}
            disabled={isProcessing || (!input.trim() && !uploadedFile)}
            className="mt-3 bg-gradient-to-r from-amber-500 to-amber-600"
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-4 h-4 ml-2 animate-spin" />
                מעבד...
              </>
            ) : (
              <>
                <Send className="w-4 h-4 ml-2" />
                שלח לעיבוד
              </>
            )}
          </Button>
        </div>

        {/* Results Panel */}
        <div className="lg:col-span-1 bg-white rounded-2xl border border-slate-200 p-4 flex flex-col">
          <h3 className="font-bold text-slate-800 mb-3">תוצאות</h3>
          
          {jobs.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-slate-400 text-sm text-center">
              <div>
                <FileText className="w-10 h-10 mx-auto mb-2 opacity-50" />
                <p>התוצאות יופיעו כאן</p>
              </div>
            </div>
          ) : (
            <ScrollArea className="flex-1">
              <div className="space-y-2">
                {jobs.map((job) => (
                  <button
                    key={job.id}
                    onClick={() => setActiveJobId(job.id)}
                    className={`w-full p-3 rounded-lg text-right transition-colors ${
                      activeJobId === job.id
                        ? 'bg-amber-50 border border-amber-300'
                        : 'bg-slate-50 hover:bg-slate-100'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Badge className={`text-xs ${
                        job.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                        job.status === 'error' ? 'bg-red-100 text-red-700' :
                        'bg-amber-100 text-amber-700'
                      }`}>
                        {job.status === 'processing' ? 'מעבד...' :
                         job.status === 'completed' ? 'הושלם' : 'שגיאה'}
                      </Badge>
                    </div>
                    <p className="text-xs text-slate-500 truncate">
                      {EDIT_OPTIONS.find(o => o.id === job.option)?.label}
                    </p>
                  </button>
                ))}
              </div>
            </ScrollArea>
          )}

          {activeJob?.result && (
            <div className="mt-3 p-3 bg-emerald-50 rounded-lg border border-emerald-200 max-h-[200px] overflow-y-auto">
              <p className="text-sm text-emerald-800 whitespace-pre-wrap">{activeJob.result}</p>
            </div>
          )}
          
          {activeJob?.error && (
            <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-200">
              <p className="text-sm text-red-700">{activeJob.error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default EditPage;
