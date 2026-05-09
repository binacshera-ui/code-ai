import { useState } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { useChatStore } from '@/stores/chatStore';
import { logRequest, logResponse, logError } from '@/stores/logStore';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  History, Search, MessageCircle, Mic, Image, FileEdit, Code, PenTool,
  Calendar, Clock, Coins, ChevronLeft, Trash2, Download, RefreshCw
} from 'lucide-react';

const TOOL_CONFIG = {
  chat: { icon: MessageCircle, label: 'משוחח', color: 'bg-blue-100 text-blue-700' },
  transcription: { icon: Mic, label: 'מתמלל', color: 'bg-purple-100 text-purple-700' },
  typing: { icon: PenTool, label: 'מקליד', color: 'bg-green-100 text-green-700' },
  images: { icon: Image, label: 'תמונות', color: 'bg-pink-100 text-pink-700' },
  edit: { icon: FileEdit, label: 'אומן הכתב', color: 'bg-amber-100 text-amber-700' },
  code: { icon: Code, label: 'מתכנת', color: 'bg-emerald-100 text-emerald-700' },
};

interface HistoryEntry {
  id: string;
  threadId: string;
  tool: keyof typeof TOOL_CONFIG;
  title: string;
  status: 'completed' | 'error' | 'in_progress';
  cost: number;
  createdAt: Date;
  messagesCount: number;
}

export function HistoryPage() {
  const { user } = useAuthStore();
  const { threads } = useChatStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTool, setFilterTool] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const historyEntries: HistoryEntry[] = threads.map(t => ({
    id: t.id,
    threadId: t.id,
    tool: t.destination as keyof typeof TOOL_CONFIG,
    title: t.title,
    status: t.status === 'active' ? 'in_progress' : t.status === 'completed' ? 'completed' : 'error',
    cost: Math.random() * 5,
    createdAt: t.createdAt,
    messagesCount: t.messages.length,
  }));

  const filteredEntries = historyEntries.filter(entry => {
    if (filterTool && entry.tool !== filterTool) return false;
    if (searchQuery && !entry.title.includes(searchQuery)) return false;
    return true;
  });

  const fetchHistory = async () => {
    setIsLoading(true);
    try {
      logRequest('/api/dashboard/history', 'GET', { email: user?.email });
      const response = await fetch(`/api/dashboard/history?email=${user?.email}`);
      const data = await response.json();
      logResponse('/api/dashboard/history', response.status, data, 0);
    } catch (err: any) {
      logError('/api/dashboard/history', err);
    } finally {
      setIsLoading(false);
    }
  };

  const totalCost = filteredEntries.reduce((sum, e) => sum + e.cost, 0);

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-slate-500 to-slate-600 rounded-xl flex items-center justify-center">
            <History className="w-5 h-5 text-white" />
          </div>
          היסטוריית פעילות
        </h1>
        <p className="text-slate-500 mt-2">צפה בכל השיחות, ההקלדות והפעולות שביצעת</p>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 mb-6">
        <div className="flex flex-wrap items-center gap-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="חפש בהיסטוריה..."
              className="pr-10"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setFilterTool(null)}
              className={`px-3 py-2 rounded-lg text-sm transition-colors ${
                !filterTool ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              הכל
            </button>
            {Object.entries(TOOL_CONFIG).map(([key, config]) => {
              const Icon = config.icon;
              return (
                <button
                  key={key}
                  onClick={() => setFilterTool(filterTool === key ? null : key)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                    filterTool === key ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {config.label}
                </button>
              );
            })}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={fetchHistory}
            disabled={isLoading}
          >
            <RefreshCw className={`w-4 h-4 ml-2 ${isLoading ? 'animate-spin' : ''}`} />
            רענן
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-4">
          <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center">
            <MessageCircle className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <p className="text-sm text-slate-500">סה"כ שיחות</p>
            <p className="text-xl font-bold text-slate-800">{filteredEntries.length}</p>
          </div>
        </div>
        
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-4">
          <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center">
            <Coins className="w-5 h-5 text-amber-600" />
          </div>
          <div>
            <p className="text-sm text-slate-500">סה"כ עלות</p>
            <p className="text-xl font-bold text-slate-800">{totalCost.toFixed(1)} בינס'</p>
          </div>
        </div>
        
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-4">
          <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center">
            <Calendar className="w-5 h-5 text-emerald-600" />
          </div>
          <div>
            <p className="text-sm text-slate-500">החודש</p>
            <p className="text-xl font-bold text-slate-800">{filteredEntries.length}</p>
          </div>
        </div>
      </div>

      {/* History List */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-bold text-slate-800">רשימת פעולות</h3>
          <Button variant="outline" size="sm">
            <Download className="w-4 h-4 ml-2" />
            ייצוא
          </Button>
        </div>

        {filteredEntries.length === 0 ? (
          <div className="p-12 text-center text-slate-400">
            <History className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>אין היסטוריה להצגה</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredEntries.map((entry) => {
              const toolConfig = TOOL_CONFIG[entry.tool];
              const Icon = toolConfig?.icon || MessageCircle;
              return (
                <div 
                  key={entry.id}
                  className="p-4 hover:bg-slate-50 cursor-pointer transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${toolConfig?.color.split(' ')[0] || 'bg-slate-100'}`}>
                      <Icon className={`w-5 h-5 ${toolConfig?.color.split(' ')[1] || 'text-slate-600'}`} />
                    </div>
                    
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-slate-800">{entry.title}</span>
                        <Badge className={toolConfig?.color || 'bg-slate-100 text-slate-600'}>
                          {toolConfig?.label || entry.tool}
                        </Badge>
                        <Badge className={`text-xs ${
                          entry.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                          entry.status === 'error' ? 'bg-red-100 text-red-700' :
                          'bg-amber-100 text-amber-700'
                        }`}>
                          {entry.status === 'completed' ? 'הושלם' :
                           entry.status === 'error' ? 'שגיאה' : 'בתהליך'}
                        </Badge>
                      </div>
                      
                      <div className="flex items-center gap-4 text-xs text-slate-500">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {entry.createdAt.toLocaleDateString('he-IL')}
                        </span>
                        <span className="flex items-center gap-1">
                          <MessageCircle className="w-3 h-3" />
                          {entry.messagesCount} הודעות
                        </span>
                        <span className="flex items-center gap-1">
                          <Coins className="w-3 h-3" />
                          {entry.cost.toFixed(1)} בינס'
                        </span>
                      </div>
                    </div>

                    <ChevronLeft className="w-5 h-5 text-slate-300" />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default HistoryPage;
