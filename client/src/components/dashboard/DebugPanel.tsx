import { useState } from 'react';
import { useLogStore, LogEntry } from '@/stores/logStore';
import { 
  Bug, X, ChevronLeft, ChevronDown, Trash2, 
  ArrowUpRight, ArrowDownLeft, AlertCircle, Info, Webhook,
  Copy, Check
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';

export function DebugPanel() {
  const { logs, isOpen, filter, togglePanel, clearLogs, setFilter } = useLogStore();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const filteredLogs = filter === 'all' 
    ? logs 
    : logs.filter(l => l.type === filter);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  if (!isOpen) {
    return (
      <button
        onClick={togglePanel}
        className="fixed bottom-4 left-4 z-50 p-3 bg-slate-800 text-white rounded-full shadow-lg hover:bg-slate-700 transition-colors"
        title="פתח לוג דיבאג"
      >
        <Bug className="w-5 h-5" />
        {logs.length > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 rounded-full text-xs flex items-center justify-center">
            {logs.length > 99 ? '99+' : logs.length}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-slate-900 text-white border-t border-slate-700 shadow-2xl" style={{ height: '40vh' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-800 border-b border-slate-700">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Bug className="w-4 h-4 text-emerald-400" />
            <span className="font-bold text-sm">לוג דיבאג</span>
            <Badge variant="secondary" className="bg-slate-700 text-slate-300 text-xs">
              {logs.length} רשומות
            </Badge>
          </div>
          
          {/* Filters */}
          <div className="flex gap-1">
            {(['all', 'request', 'response', 'error', 'webhook'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2 py-1 text-xs rounded ${
                  filter === f 
                    ? 'bg-indigo-600 text-white' 
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                {f === 'all' ? 'הכל' : f === 'request' ? 'בקשות' : f === 'response' ? 'תגובות' : f === 'error' ? 'שגיאות' : 'webhook'}
              </button>
            ))}
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={clearLogs}
            className="text-slate-400 hover:text-white hover:bg-slate-700 h-7"
          >
            <Trash2 className="w-4 h-4 ml-1" />
            נקה
          </Button>
          <button
            onClick={togglePanel}
            className="p-1 hover:bg-slate-700 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Log entries */}
      <ScrollArea className="h-[calc(40vh-48px)]">
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-500">
            <Bug className="w-12 h-12 mb-2 opacity-50" />
            <p>אין רשומות לוג עדיין</p>
            <p className="text-xs">שלח בקשה כדי לראות מה קורה</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-800">
            {filteredLogs.map((log) => (
              <LogEntryRow
                key={log.id}
                log={log}
                isExpanded={expandedId === log.id}
                onToggle={() => setExpandedId(expandedId === log.id ? null : log.id)}
                onCopy={(text) => copyToClipboard(text, log.id)}
                isCopied={copiedId === log.id}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function LogEntryRow({ 
  log, 
  isExpanded, 
  onToggle, 
  onCopy,
  isCopied 
}: { 
  log: LogEntry; 
  isExpanded: boolean;
  onToggle: () => void;
  onCopy: (text: string) => void;
  isCopied: boolean;
}) {
  const getTypeIcon = () => {
    switch (log.type) {
      case 'request': return <ArrowUpRight className="w-4 h-4 text-blue-400" />;
      case 'response': return <ArrowDownLeft className="w-4 h-4 text-emerald-400" />;
      case 'error': return <AlertCircle className="w-4 h-4 text-red-400" />;
      case 'webhook': return <Webhook className="w-4 h-4 text-purple-400" />;
      default: return <Info className="w-4 h-4 text-slate-400" />;
    }
  };

  const getTypeBg = () => {
    switch (log.type) {
      case 'request': return 'bg-blue-500/10';
      case 'response': return 'bg-emerald-500/10';
      case 'error': return 'bg-red-500/10';
      case 'webhook': return 'bg-purple-500/10';
      default: return 'bg-slate-500/10';
    }
  };

  const getStatusColor = () => {
    if (!log.status) return '';
    if (log.status >= 200 && log.status < 300) return 'text-emerald-400';
    if (log.status >= 400) return 'text-red-400';
    return 'text-amber-400';
  };

  return (
    <div className={`${getTypeBg()} hover:bg-slate-800/50`}>
      <div 
        className="flex items-center gap-3 px-4 py-2 cursor-pointer"
        onClick={onToggle}
        style={{
          display: 'grid',
          gridTemplateColumns: '20px 90px 60px 200px 1fr 80px 24px',
          gap: '12px',
          alignItems: 'center',
        }}
      >
        {getTypeIcon()}
        <span className="text-xs text-slate-400 font-mono">
          {log.timestamp.toLocaleTimeString('he-IL')}
        </span>
        <span className={`text-xs font-mono font-bold ${getStatusColor()}`}>
          {log.method && <span className="text-slate-500">{log.method} </span>}
          {log.status || '-'}
        </span>
        <span className="text-xs font-mono text-slate-300 truncate">
          {log.endpoint}
        </span>
        <span className="text-xs text-slate-500 truncate">
          {typeof log.data === 'object' 
            ? Object.keys(log.data).slice(0, 3).join(', ') + (Object.keys(log.data).length > 3 ? '...' : '')
            : String(log.data).slice(0, 50)
          }
        </span>
        {log.duration && (
          <span className="text-xs text-slate-400 font-mono">
            {log.duration}ms
          </span>
        )}
        {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
      </div>
      
      {isExpanded && (
        <div className="px-4 py-3 bg-slate-950 border-t border-slate-800">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs text-slate-400 font-bold">נתונים מלאים:</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCopy(log.rawPayload || JSON.stringify(log.data, null, 2));
              }}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-slate-800 rounded hover:bg-slate-700"
            >
              {isCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              {isCopied ? 'הועתק!' : 'העתק'}
            </button>
          </div>
          <pre 
            className="text-xs font-mono text-slate-300 overflow-x-auto p-3 bg-slate-900 rounded max-h-[200px] overflow-y-auto"
            dir="ltr"
          >
            {log.rawPayload || JSON.stringify(log.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export default DebugPanel;
