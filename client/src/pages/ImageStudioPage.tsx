import { useState, useRef } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { logRequest, logResponse, logError, logWebhook } from '@/stores/logStore';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { 
  Image, Wand2, Eraser, Type, Loader2, 
  Download, RefreshCw, Upload, Sparkles
} from 'lucide-react';

const IMAGE_OPTIONS = [
  { id: 'new_image', label: 'יצירת תמונה', icon: Sparkles, description: 'יצירת תמונה חדשה מתיאור', price: 2 },
  { id: 'edit_image', label: 'עריכת תמונה', icon: Wand2, description: 'שינוי תמונה קיימת', price: 2 },
  { id: 'remove_background', label: 'הסרת רקע', icon: Eraser, description: 'הסרת רקע מתמונה', price: 1 },
  { id: 'add_hebrew_text', label: 'טקסט בעברית', icon: Type, description: 'הוספת טקסט עברי לתמונה', price: 1.5 },
  { id: 'product_image', label: 'תמונת מוצר', icon: Image, description: 'צילום מוצר מקצועי', price: 3 },
];

interface GeneratedImage {
  id: string;
  prompt: string;
  option: string;
  url?: string;
  status: 'generating' | 'completed' | 'error';
  error?: string;
  createdAt: Date;
}

export function ImageStudioPage() {
  const { user } = useAuthStore();
  const [selectedOption, setSelectedOption] = useState(IMAGE_OPTIONS[0].id);
  const [prompt, setPrompt] = useState('');
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [uploadedImage, setUploadedImage] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    if (!user) return;

    const image: GeneratedImage = {
      id: `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      prompt: prompt.trim(),
      option: selectedOption,
      status: 'generating',
      createdAt: new Date(),
    };

    setImages(prev => [image, ...prev]);
    setIsGenerating(true);

    const webhookPayload = {
      thread: { id: image.id },
      message: {
        from: { address: user.email },
        to: [{ address: 'image.bina.cshera@gmail.com' }],
        subject: `תמונה: ${prompt.slice(0, 50)}`,
        text: prompt,
      },
      attachments: uploadedImage ? [{
        fileName: uploadedImage.name,
        contentType: uploadedImage.type,
        fileSize: uploadedImage.size,
      }] : [],
      ai_analysis: {
        role: 'new_request',
        image_option: selectedOption,
      },
      source: 'web_ui',
    };

    logWebhook('/api/dashboard/images', webhookPayload);

    try {
      const startTime = Date.now();
      logRequest('/api/dashboard/images', 'POST', { prompt, option: selectedOption });

      const formData = new FormData();
      formData.append('prompt', prompt);
      formData.append('option', selectedOption);
      formData.append('email', user.email);
      if (uploadedImage) {
        formData.append('image', uploadedImage);
      }

      const response = await fetch('/api/dashboard/images', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();
      const duration = Date.now() - startTime;
      logResponse('/api/dashboard/images', response.status, data, duration);

      if (!response.ok) {
        throw new Error(data.error || 'שגיאה ביצירת התמונה');
      }

      setImages(prev => prev.map(img => 
        img.id === image.id 
          ? { ...img, status: 'completed', url: data.url || 'https://placehold.co/512x512/6366f1/white?text=תמונה+נוצרה' } 
          : img
      ));

      setPrompt('');
      setUploadedImage(null);

    } catch (err: any) {
      logError('/api/dashboard/images', err);
      setImages(prev => prev.map(img => 
        img.id === image.id 
          ? { ...img, status: 'error', error: err.message } 
          : img
      ));
    } finally {
      setIsGenerating(false);
    }
  };

  const needsUpload = ['edit_image', 'remove_background', 'add_hebrew_text'].includes(selectedOption);

  return (
    <div className="p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-pink-500 to-pink-600 rounded-xl flex items-center justify-center">
            <Image className="w-5 h-5 text-white" />
          </div>
          מחולל תמונות
        </h1>
        <p className="text-slate-500 mt-2">יצירה ועריכת תמונות עם AI</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Panel - Options & Input */}
        <div className="lg:col-span-1 space-y-6">
          {/* Options */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <h3 className="font-bold text-slate-800 mb-3">סוג פעולה</h3>
            <div className="space-y-2">
              {IMAGE_OPTIONS.map((option) => {
                const Icon = option.icon;
                return (
                  <button
                    key={option.id}
                    onClick={() => setSelectedOption(option.id)}
                    className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all ${
                      selectedOption === option.id
                        ? 'bg-pink-50 border-2 border-pink-500'
                        : 'bg-slate-50 border-2 border-transparent hover:bg-slate-100'
                    }`}
                  >
                    <Icon className={`w-5 h-5 ${selectedOption === option.id ? 'text-pink-600' : 'text-slate-500'}`} />
                    <div className="text-right flex-1">
                      <p className="font-medium text-slate-800">{option.label}</p>
                      <p className="text-xs text-slate-500">{option.description}</p>
                    </div>
                    <Badge className="bg-pink-100 text-pink-700 border-0">{option.price}</Badge>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Image Upload (if needed) */}
          {needsUpload && (
            <div className="bg-white rounded-2xl border border-slate-200 p-4">
              <h3 className="font-bold text-slate-800 mb-3">תמונה מקורית</h3>
              <input
                type="file"
                ref={fileInputRef}
                onChange={(e) => e.target.files?.[0] && setUploadedImage(e.target.files[0])}
                accept="image/*"
                className="hidden"
              />
              {uploadedImage ? (
                <div className="relative">
                  <img 
                    src={URL.createObjectURL(uploadedImage)} 
                    alt="Uploaded" 
                    className="w-full rounded-xl"
                  />
                  <button
                    onClick={() => setUploadedImage(null)}
                    className="absolute top-2 left-2 p-1.5 bg-red-500 text-white rounded-full"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full p-8 border-2 border-dashed border-slate-300 rounded-xl hover:border-pink-400 transition-colors"
                >
                  <Upload className="w-8 h-8 mx-auto text-slate-400 mb-2" />
                  <p className="text-sm text-slate-500">העלה תמונה</p>
                </button>
              )}
            </div>
          )}

          {/* Prompt Input */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <h3 className="font-bold text-slate-800 mb-3">תיאור</h3>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                selectedOption === 'new_image' 
                  ? 'תאר את התמונה שברצונך ליצור...' 
                  : 'תאר את השינוי שברצונך לבצע...'
              }
              className="min-h-[120px] resize-none"
            />
            <Button
              onClick={handleGenerate}
              disabled={isGenerating || !prompt.trim() || (needsUpload && !uploadedImage)}
              className="w-full mt-3 bg-gradient-to-r from-pink-500 to-pink-600"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 ml-2 animate-spin" />
                  יוצר...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 ml-2" />
                  צור תמונה
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Right Panel - Gallery */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <h3 className="font-bold text-slate-800 mb-4">גלריה</h3>
            
            {images.length === 0 ? (
              <div className="text-center py-16 text-slate-400">
                <Image className="w-16 h-16 mx-auto mb-4 opacity-50" />
                <p>התמונות שתיצור יופיעו כאן</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                {images.map((image) => (
                  <div key={image.id} className="relative group">
                    {image.status === 'generating' ? (
                      <div className="aspect-square bg-slate-100 rounded-xl flex items-center justify-center">
                        <div className="text-center">
                          <Loader2 className="w-8 h-8 animate-spin text-pink-500 mx-auto mb-2" />
                          <p className="text-sm text-slate-500">יוצר...</p>
                        </div>
                      </div>
                    ) : image.status === 'error' ? (
                      <div className="aspect-square bg-red-50 rounded-xl flex items-center justify-center p-4">
                        <p className="text-sm text-red-600 text-center">{image.error}</p>
                      </div>
                    ) : (
                      <>
                        <img 
                          src={image.url} 
                          alt={image.prompt}
                          className="aspect-square w-full object-cover rounded-xl"
                        />
                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-xl flex items-center justify-center gap-2">
                          <Button size="sm" variant="secondary" className="h-8">
                            <Download className="w-4 h-4" />
                          </Button>
                          <Button size="sm" variant="secondary" className="h-8">
                            <RefreshCw className="w-4 h-4" />
                          </Button>
                        </div>
                      </>
                    )}
                    <p className="text-xs text-slate-500 mt-2 truncate">{image.prompt}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ImageStudioPage;
