import { useState, useRef, useEffect } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { useChatStore, ChatMessage } from '@/stores/chatStore';
import { logRequest, logResponse, logError, logWebhook } from '@/stores/logStore';
import { useSubmitGuard } from '@/lib/useSubmitGuard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Send, Paperclip, Loader2, Bot, User, Plus, Trash2,
  List, Table, Route, CheckSquare, Eye, Search, FileText,
  ChevronDown, X
} from 'lucide-react';

const CHAT_OPTIONS = [
  { id: 'simple_chat', label: 'שיחה רגילה', icon: List, description: 'שיחה חופשית ללא הגבלה' },
  { id: 'three_levels', label: '3 רמות', icon: Eye, description: 'תשובה בשלוש רמות עומק' },
  { id: 'travel_planner', label: 'מסלול נסיעה', icon: Route, description: 'יצירת מסלול עם גוגל מפות' },
  { id: 'excel_creation', label: 'יצירת טבלה', icon: Table, description: 'הפיכת נתונים לטבלה' },
  { id: 'task_decomposition', label: 'משימות', icon: CheckSquare, description: 'ניהול ומעקב משימות' },
  { id: 'multiple_perspectives', label: 'זוויות תשובה', icon: Eye, description: 'תשובה מכמה זוויות' },
  { id: 'sequential_messages', label: 'תשובה ארוכה', icon: FileText, description: 'תשובה מפורטת וארוכה' },
  { id: 'fact_check', label: 'בדיקת עובדות', icon: Search, description: 'בדיקה ואימות טענות' },
];

export function ChatPage() {
  const { user } = useAuthStore();
  const { 
    threads, activeThreadId, isLoading,
    createThread, setActiveThread, addMessage, updateMessage, setLoading 
  } = useChatStore();
  
  const [input, setInput] = useState('');
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { beginSubmit, endSubmit } = useSubmitGuard();

  const activeThread = threads.find(t => t.id === activeThreadId);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeThread?.messages]);

  const handleSend = async () => {
    const messageContent = input.trim();
    const selectedToolChoice = selectedOption;
    const attachedFiles = files;

    if (!messageContent && attachedFiles.length === 0) return;
    if (!user || isLoading || !beginSubmit()) return;

    let threadId = activeThreadId;
    if (!threadId) {
      threadId = createThread('chat');
    }

    setInput('');
    setShowOptions(false);
    setFiles([]);
    setSelectedOption(null);

    addMessage(threadId, {
      role: 'user',
      content: messageContent,
      files: attachedFiles.map(f => ({ name: f.name, type: f.type, size: f.size })),
      toolChoice: selectedToolChoice || undefined,
      status: 'sending',
    });

    setLoading(true);

    const webhookPayload = {
      thread: { id: threadId },
      message: {
        id: `msg-${Date.now()}`,
        headers: { messageId: `<${threadId}@web.bina-cshera.co.il>` },
        date: new Date().toISOString(),
        subject: selectedToolChoice ? `[${CHAT_OPTIONS.find(o => o.id === selectedToolChoice)?.label}]` : 'שיחה',
        text: messageContent,
        html: `<div dir="rtl">${messageContent}</div>`,
        from: { name: user.name || '', address: user.email },
        to: [{ name: 'בינה כשרה', address: 'chat@app.bina-cshera.co.il' }],
      },
      attachments: [],
      ai_analysis: {
        role: 'new_request',
        tool_choice: selectedToolChoice || 'simple_chat',
        explanation: 'Web UI request',
        context_mode: 'text_context',
      },
      source: 'web_ui',
    };

    logWebhook('/api/dashboard/chat', webhookPayload);

    try {
      const startTime = Date.now();
      logRequest('/api/dashboard/chat', 'POST', { threadId, message: messageContent, toolChoice: selectedToolChoice });

      const response = await fetch('/api/dashboard/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookPayload),
      });

      const data = await response.json();
      const duration = Date.now() - startTime;
      logResponse('/api/dashboard/chat', response.status, data, duration);

      if (!response.ok) {
        throw new Error(data.error || 'שגיאה בשליחת ההודעה');
      }

      addMessage(threadId, {
        role: 'assistant',
        content: data.response || data.message || 'התקבלה תשובה מהמערכת',
        status: 'sent',
      });

    } catch (err: any) {
      logError('/api/dashboard/chat', err);
      addMessage(threadId, {
        role: 'assistant',
        content: `שגיאה: ${err.message}`,
        status: 'error',
      });
    } finally {
      endSubmit();
      setLoading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(prev => [...prev, ...Array.from(e.target.files!)]);
    }
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="h-screen flex" style={{ maxHeight: 'calc(100vh - 40vh)' }}>
      {/* Threads Sidebar */}
      <div className="w-64 bg-white border-l border-slate-200 flex flex-col">
        <div className="p-3 border-b border-slate-200">
          <Button
            onClick={() => createThread('chat')}
            className="w-full bg-gradient-to-r from-blue-500 to-blue-600"
          >
            <Plus className="w-4 h-4 ml-2" />
            שיחה חדשה
          </Button>
        </div>
        
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {threads.filter(t => t.destination === 'chat').map((thread) => (
              <button
                key={thread.id}
                onClick={() => setActiveThread(thread.id)}
                className={`w-full p-3 rounded-lg text-right transition-colors ${
                  activeThreadId === thread.id
                    ? 'bg-blue-50 text-blue-700 border border-blue-200'
                    : 'hover:bg-slate-50 text-slate-600'
                }`}
              >
                <p className="text-sm font-medium truncate">{thread.title}</p>
                <p className="text-xs text-slate-400 mt-1">
                  {thread.messages.length} הודעות
                </p>
              </button>
            ))}
            {threads.filter(t => t.destination === 'chat').length === 0 && (
              <p className="text-center text-slate-400 text-sm py-8">
                אין שיחות עדיין
              </p>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col bg-slate-50">
        {/* Messages */}
        <ScrollArea className="flex-1 p-4">
          {activeThread?.messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {isLoading && (
            <div className="flex items-center gap-2 text-slate-500 py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>מעבד...</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </ScrollArea>

        {/* Options Bar */}
        {showOptions && (
          <div className="bg-white border-t border-slate-200 p-3">
            <div className="flex flex-wrap gap-2">
              {CHAT_OPTIONS.map((option) => {
                const Icon = option.icon;
                const isSelected = selectedOption === option.id;
                return (
                  <button
                    key={option.id}
                    onClick={() => setSelectedOption(isSelected ? null : option.id)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      isSelected
                        ? 'bg-blue-100 text-blue-700 border border-blue-300'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                    title={option.description}
                  >
                    <Icon className="w-4 h-4" />
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Files Preview */}
        {files.length > 0 && (
          <div className="bg-white border-t border-slate-200 px-4 py-2 flex gap-2 flex-wrap">
            {files.map((file, index) => (
              <div key={index} className="flex items-center gap-2 bg-slate-100 px-3 py-1.5 rounded-lg">
                <span className="text-sm text-slate-600 truncate max-w-[150px]">{file.name}</span>
                <button onClick={() => removeFile(index)} className="text-slate-400 hover:text-red-500">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Input Area */}
        <div className="bg-white border-t border-slate-200 p-4">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowOptions(!showOptions)}
              className={`p-2.5 rounded-lg transition-colors ${
                showOptions ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              }`}
              title="אפשרויות"
            >
              <ChevronDown className={`w-5 h-5 transition-transform ${showOptions ? 'rotate-180' : ''}`} />
            </button>
            
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              className="hidden"
              multiple
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-2.5 bg-slate-100 text-slate-500 rounded-lg hover:bg-slate-200 transition-colors"
              title="צרף קובץ"
            >
              <Paperclip className="w-5 h-5" />
            </button>

            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={selectedOption 
                ? `${CHAT_OPTIONS.find(o => o.id === selectedOption)?.label}: כתוב את ההודעה שלך...`
                : 'כתוב את ההודעה שלך...'
              }
              className="flex-1"
              disabled={isLoading}
            />

            <Button
              onClick={handleSend}
              disabled={isLoading || (!input.trim() && files.length === 0)}
              className="bg-gradient-to-r from-blue-500 to-blue-600 px-4"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </Button>
          </div>
          
          {selectedOption && (
            <div className="mt-2 flex items-center gap-2">
              <Badge className="bg-blue-100 text-blue-700 border-0">
                {CHAT_OPTIONS.find(o => o.id === selectedOption)?.label}
              </Badge>
              <button 
                onClick={() => setSelectedOption(null)}
                className="text-xs text-slate-400 hover:text-slate-600"
              >
                הסר
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  
  return (
    <div className={`flex gap-3 mb-4 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
        isUser ? 'bg-blue-500' : 'bg-slate-200'
      }`}>
        {isUser ? (
          <User className="w-4 h-4 text-white" />
        ) : (
          <Bot className="w-4 h-4 text-slate-600" />
        )}
      </div>
      
      <div className={`max-w-[70%] ${isUser ? 'text-right' : 'text-right'}`}>
        <div className={`px-4 py-3 rounded-2xl ${
          isUser 
            ? 'bg-blue-500 text-white rounded-tl-sm' 
            : 'bg-white border border-slate-200 text-slate-800 rounded-tr-sm'
        }`}>
          <p className="text-sm whitespace-pre-wrap">{message.content}</p>
        </div>
        
        <div className="flex items-center gap-2 mt-1 px-2">
          {message.toolChoice && (
            <Badge variant="secondary" className="text-xs">
              {CHAT_OPTIONS.find(o => o.id === message.toolChoice)?.label || message.toolChoice}
            </Badge>
          )}
          <span className="text-xs text-slate-400">
            {message.timestamp.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
          </span>
          {message.status === 'error' && (
            <span className="text-xs text-red-500">שגיאה</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default ChatPage;
