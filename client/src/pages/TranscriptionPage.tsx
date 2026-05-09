import { useState, useRef } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { logRequest, logResponse, logError, logWebhook } from '@/stores/logStore';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { 
  Upload, Mic, FileAudio, FileVideo, Loader2, 
  Check, X, Clock, Coins
} from 'lucide-react';

const TRANSCRIPTION_OPTIONS = [
  { id: 'transcription_only', label: 'תמלול בלבד', description: 'תמלול גולמי ללא עריכה', price: 1.5 },
  { id: 'transcription_hebrew', label: 'עריכה לעברית', description: 'תמלול + עריכה לעברית תקנית', price: 2.0 },
  { id: 'transcription_yeshivish', label: 'עברית ישיבתית', description: 'עריכה בסגנון לשון ישיבתית', price: 2.0 },
  { id: 'transcription_yiddish', label: 'אידיש', description: 'תמלול + עריכה באידיש', price: 2.5 },
  { id: 'transcription_other', label: 'שפה אחרת', description: 'תמלול לכל שפה נדרשת', price: 2.0 },
];

interface TranscriptionJob {
  id: string;
  fileName: string;
  duration: number;
  option: string;
  status: 'uploading' | 'processing' | 'completed' | 'error';
  progress: number;
  result?: string;
  error?: string;
  createdAt: Date;
}

export function TranscriptionPage() {
  const { user } = useAuthStore();
  const [selectedOption, setSelectedOption] = useState(TRANSCRIPTION_OPTIONS[0].id);
  const [jobs, setJobs] = useState<TranscriptionJob[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList) => {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('audio/') && !file.type.startsWith('video/')) {
        continue;
      }

      const job: TranscriptionJob = {
        id: `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        fileName: file.name,
        duration: 0,
        option: selectedOption,
        status: 'uploading',
        progress: 0,
        createdAt: new Date(),
      };

      setJobs(prev => [job, ...prev]);

      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('option', selectedOption);
        formData.append('email', user?.email || '');

        const webhookPayload = {
          thread: { id: job.id },
          message: {
            from: { address: user?.email },
            to: [{ address: 'timlul.bina.cshera@gmail.com' }],
            subject: `תמלול: ${file.name}`,
          },
          attachments: [{
            fileName: file.name,
            contentType: file.type,
            fileSize: file.size,
          }],
          source: 'web_ui',
          transcription_option: selectedOption,
        };

        logWebhook('/api/dashboard/transcription', webhookPayload);

        setJobs(prev => prev.map(j => 
          j.id === job.id ? { ...j, status: 'uploading', progress: 50 } : j
        ));

        const startTime = Date.now();
        logRequest('/api/dashboard/transcription', 'POST', { fileName: file.name, option: selectedOption });

        const response = await fetch('/api/dashboard/transcription', {
          method: 'POST',
          body: formData,
        });

        const data = await response.json();
        const duration = Date.now() - startTime;
        logResponse('/api/dashboard/transcription', response.status, data, duration);

        if (!response.ok) {
          throw new Error(data.error || 'שגיאה בהעלאת הקובץ');
        }

        setJobs(prev => prev.map(j => 
          j.id === job.id 
            ? { ...j, status: 'processing', progress: 75, duration: data.duration || 0 } 
            : j
        ));

        setTimeout(() => {
          setJobs(prev => prev.map(j => 
            j.id === job.id 
              ? { ...j, status: 'completed', progress: 100, result: data.result || 'התמלול הושלם' } 
              : j
          ));
        }, 2000);

      } catch (err: any) {
        logError('/api/dashboard/transcription', err);
        setJobs(prev => prev.map(j => 
          j.id === job.id 
            ? { ...j, status: 'error', error: err.message } 
            : j
        ));
      }
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const selectedOptionData = TRANSCRIPTION_OPTIONS.find(o => o.id === selectedOption);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-purple-500 to-purple-600 rounded-xl flex items-center justify-center">
            <Mic className="w-5 h-5 text-white" />
          </div>
          מתמלל
        </h1>
        <p className="text-slate-500 mt-2">תמלול קבצי אודיו ווידאו עם עריכה מקצועית</p>
      </div>

      {/* Options Selection */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 mb-6">
        <h2 className="font-bold text-slate-800 mb-4">בחר אפשרות תמלול</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {TRANSCRIPTION_OPTIONS.map((option) => (
            <button
              key={option.id}
              onClick={() => setSelectedOption(option.id)}
              className={`p-4 rounded-xl border-2 text-right transition-all ${
                selectedOption === option.id
                  ? 'border-purple-500 bg-purple-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-bold text-slate-800">{option.label}</span>
                {selectedOption === option.id && (
                  <Check className="w-5 h-5 text-purple-500" />
                )}
              </div>
              <p className="text-sm text-slate-500 mb-2">{option.description}</p>
              <div className="flex items-center gap-1 text-purple-600">
                <Coins className="w-4 h-4" />
                <span className="font-bold">{option.price}</span>
                <span className="text-xs text-slate-400">בינס' לדקה</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Upload Area */}
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`bg-white rounded-2xl border-2 border-dashed p-12 text-center transition-all ${
          isDragging 
            ? 'border-purple-500 bg-purple-50' 
            : 'border-slate-300 hover:border-slate-400'
        }`}
      >
        <input
          type="file"
          ref={fileInputRef}
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
          accept="audio/*,video/*"
          multiple
          className="hidden"
        />
        
        <div className="w-16 h-16 bg-purple-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Upload className="w-8 h-8 text-purple-600" />
        </div>
        
        <h3 className="text-lg font-bold text-slate-800 mb-2">
          גרור קבצי אודיו או וידאו לכאן
        </h3>
        <p className="text-slate-500 mb-4">
          או לחץ לבחירת קבצים
        </p>
        
        <Button
          onClick={() => fileInputRef.current?.click()}
          className="bg-gradient-to-r from-purple-500 to-purple-600"
        >
          בחר קבצים
        </Button>

        <p className="text-xs text-slate-400 mt-4">
          נתמכים: MP3, WAV, M4A, MP4, MOV, WEBM
        </p>
      </div>

      {/* Jobs List */}
      {jobs.length > 0 && (
        <div className="mt-6 bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <div className="p-4 border-b border-slate-200">
            <h3 className="font-bold text-slate-800">עבודות תמלול</h3>
          </div>
          
          <div className="divide-y divide-slate-100">
            {jobs.map((job) => (
              <div key={job.id} className="p-4">
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                    job.status === 'completed' ? 'bg-emerald-100' :
                    job.status === 'error' ? 'bg-red-100' :
                    'bg-purple-100'
                  }`}>
                    {job.status === 'completed' ? <Check className="w-5 h-5 text-emerald-600" /> :
                     job.status === 'error' ? <X className="w-5 h-5 text-red-600" /> :
                     job.fileName.includes('.mp4') || job.fileName.includes('.mov') 
                       ? <FileVideo className="w-5 h-5 text-purple-600" />
                       : <FileAudio className="w-5 h-5 text-purple-600" />
                    }
                  </div>
                  
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-slate-800">{job.fileName}</span>
                      <Badge className={`text-xs ${
                        job.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                        job.status === 'error' ? 'bg-red-100 text-red-700' :
                        'bg-purple-100 text-purple-700'
                      }`}>
                        {job.status === 'uploading' ? 'מעלה...' :
                         job.status === 'processing' ? 'מעבד...' :
                         job.status === 'completed' ? 'הושלם' : 'שגיאה'}
                      </Badge>
                    </div>
                    
                    <div className="flex items-center gap-4 text-xs text-slate-500">
                      <span>{TRANSCRIPTION_OPTIONS.find(o => o.id === job.option)?.label}</span>
                      {job.duration > 0 && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {Math.round(job.duration / 60)} דקות
                        </span>
                      )}
                    </div>
                    
                    {(job.status === 'uploading' || job.status === 'processing') && (
                      <Progress value={job.progress} className="mt-2 h-1" />
                    )}
                    
                    {job.error && (
                      <p className="text-sm text-red-600 mt-2">{job.error}</p>
                    )}
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

export default TranscriptionPage;
