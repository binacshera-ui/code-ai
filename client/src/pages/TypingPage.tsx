import { useRef, useState } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { logRequest, logResponse, logError, logWebhook } from '@/stores/logStore';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Upload, PenTool, FileText, FileArchive, Image as ImageIcon,
  Check, X, Coins
} from 'lucide-react';

const TYPING_OPTIONS = [
  { id: 'typing_raw', label: 'הקלדה גולמית', description: 'פלט נקי לפי כתב היד ללא הגהה נוספת', price: 14 },
  { id: 'typing_proofread', label: 'הקלדה כולל הגהה', description: 'הקלדה עם תיקוני שגיאות ויישור טקסט', price: 16 },
  { id: 'typing_proofread_edit', label: 'הקלדה כולל הגהה ועריכה', description: 'כולל הגהה ועריכה לשונית בסיסית', price: 18 },
];

interface TypingJob {
  id: string;
  fileNames: string[];
  option: string;
  status: 'uploading' | 'processing' | 'completed' | 'error';
  progress: number;
  result?: string;
  error?: string;
  createdAt: Date;
}

export default function TypingPage() {
  const { user } = useAuthStore();
  const [selectedOption, setSelectedOption] = useState(TYPING_OPTIONS[0].id);
  const [jobs, setJobs] = useState<TypingJob[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList) => {
    const accepted = Array.from(files).filter((file) => {
      const lowerName = file.name.toLowerCase();
      return (
        file.type.startsWith('image/') ||
        file.type === 'application/pdf' ||
        lowerName.endsWith('.zip') ||
        lowerName.endsWith('.pdf') ||
        lowerName.endsWith('.jpg') ||
        lowerName.endsWith('.jpeg') ||
        lowerName.endsWith('.png') ||
        lowerName.endsWith('.webp') ||
        lowerName.endsWith('.tif') ||
        lowerName.endsWith('.tiff')
      );
    });

    if (accepted.length === 0) return;

    const job: TypingJob = {
      id: `typing-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      fileNames: accepted.map(file => file.name),
      option: selectedOption,
      status: 'uploading',
      progress: 0,
      createdAt: new Date(),
    };

    setJobs(prev => [job, ...prev]);

    try {
      const formData = new FormData();
      accepted.forEach(file => formData.append('files', file));
      formData.append('option', selectedOption);
      formData.append('email', user?.email || '');

      const webhookPayload = {
        thread: { id: job.id },
        message: {
          from: { address: user?.email },
          to: [{ address: 'typing.bina.cshera@gmail.com' }],
          subject: `הקלדת כתבי יד: ${accepted[0]?.name || 'מסמכים'}`,
        },
        attachments: accepted.map(file => ({
          fileName: file.name,
          contentType: file.type,
          fileSize: file.size,
        })),
        source: 'web_ui',
        typing_option: selectedOption,
      };

      logWebhook('/api/dashboard/typing', webhookPayload);
      setJobs(prev => prev.map(j => j.id === job.id ? { ...j, progress: 45 } : j));

      const startTime = Date.now();
      logRequest('/api/dashboard/typing', 'POST', { files: accepted.map(file => file.name), option: selectedOption });
      const response = await fetch('/api/dashboard/typing', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();
      const duration = Date.now() - startTime;
      logResponse('/api/dashboard/typing', response.status, data, duration);

      if (!response.ok) {
        throw new Error(data.error || 'שגיאה בשליחת עבודת ההקלדה');
      }

      setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'processing', progress: 80 } : j));

      setTimeout(() => {
        setJobs(prev => prev.map(j =>
          j.id === job.id
            ? { ...j, status: 'completed', progress: 100, result: data.result || 'עבודת ההקלדה נרשמה ותמשיך בשרשרת.' }
            : j
        ));
      }, 1500);
    } catch (err: any) {
      logError('/api/dashboard/typing', err);
      setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'error', error: err.message } : j));
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-green-500 to-green-700 rounded-xl flex items-center justify-center">
            <PenTool className="w-5 h-5 text-white" />
          </div>
          מקליד
        </h1>
        <p className="text-slate-500 mt-2">הקלדת כתבי יד סרוקים מתוך PDF, תמונות ו-ZIP</p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-6 mb-6">
        <h2 className="font-bold text-slate-800 mb-4">בחר מסלול הקלדה</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {TYPING_OPTIONS.map((option) => (
            <button
              key={option.id}
              onClick={() => setSelectedOption(option.id)}
              className={`p-4 rounded-xl border-2 text-right transition-all ${
                selectedOption === option.id
                  ? 'border-green-600 bg-green-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-bold text-slate-800">{option.label}</span>
                {selectedOption === option.id && <Check className="w-5 h-5 text-green-600" />}
              </div>
              <p className="text-sm text-slate-500 mb-2">{option.description}</p>
              <div className="flex items-center gap-1 text-green-700">
                <Coins className="w-4 h-4" />
                <span className="font-bold">{option.price}</span>
                <span className="text-xs text-slate-400">בינס' ל-1000 תווים</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`bg-white rounded-2xl border-2 border-dashed p-12 text-center transition-all ${
          isDragging ? 'border-green-600 bg-green-50' : 'border-slate-300 hover:border-slate-400'
        }`}
      >
        <input
          type="file"
          ref={fileInputRef}
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
          accept=".pdf,.zip,image/*,.jpg,.jpeg,.png,.webp,.tif,.tiff"
          multiple
          className="hidden"
        />

        <div className="w-16 h-16 bg-green-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Upload className="w-8 h-8 text-green-700" />
        </div>

        <h3 className="text-lg font-bold text-slate-800 mb-2">
          גרור לכאן כתבי יד, PDF, תמונות או ZIP
        </h3>
        <p className="text-slate-500 mb-4">
          אפשר להעלות כמה קבצים יחד באותה עבודה
        </p>

        <Button
          onClick={() => fileInputRef.current?.click()}
          className="bg-gradient-to-r from-green-500 to-green-700"
        >
          בחר קבצים
        </Button>

        <div className="mt-5 flex flex-wrap justify-center gap-3 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1"><FileText className="w-3 h-3" /> PDF</span>
          <span className="inline-flex items-center gap-1"><ImageIcon className="w-3 h-3" /> תמונות</span>
          <span className="inline-flex items-center gap-1"><FileArchive className="w-3 h-3" /> ZIP</span>
        </div>
      </div>

      {jobs.length > 0 && (
        <div className="mt-6 bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="p-4 border-b border-slate-200">
            <h3 className="font-bold text-slate-800">עבודות הקלדה</h3>
          </div>
          <div className="divide-y divide-slate-100">
            {jobs.map((job) => (
              <div key={job.id} className="p-4">
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                    job.status === 'completed' ? 'bg-emerald-100' :
                    job.status === 'error' ? 'bg-red-100' :
                    'bg-green-100'
                  }`}>
                    {job.status === 'completed' ? <Check className="w-5 h-5 text-emerald-600" /> :
                     job.status === 'error' ? <X className="w-5 h-5 text-red-600" /> :
                     <PenTool className="w-5 h-5 text-green-700" />}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-slate-800">{job.fileNames.join(', ')}</span>
                      <Badge className={`text-xs ${
                        job.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                        job.status === 'error' ? 'bg-red-100 text-red-700' :
                        'bg-green-100 text-green-700'
                      }`}>
                        {job.status === 'uploading' ? 'מעלה...' :
                         job.status === 'processing' ? 'בתהליך...' :
                         job.status === 'completed' ? 'נרשם' : 'שגיאה'}
                      </Badge>
                    </div>
                    <p className="text-xs text-slate-500 mb-2">{new Date(job.createdAt).toLocaleString('he-IL')}</p>
                    {job.status !== 'completed' && job.status !== 'error' && (
                      <Progress value={job.progress} className="h-2" />
                    )}
                    {job.result && <p className="text-sm text-slate-600 mt-2">{job.result}</p>}
                    {job.error && <p className="text-sm text-red-600 mt-2">{job.error}</p>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
