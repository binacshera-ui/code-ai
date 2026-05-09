import { useAuthStore } from '@/stores/authStore';
import { 
  MessageCircle, Mic, Image, FileEdit, Code, PenTool,
  ArrowLeft, TrendingUp, Clock, Zap
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

type PageType = 'home' | 'chat' | 'transcription' | 'typing' | 'images' | 'edit' | 'code' | 'history' | 'settings';

interface Props {
  onNavigate: (page: PageType) => void;
}

const TOOLS = [
  {
    id: 'chat' as const,
    icon: MessageCircle,
    title: 'משוחח',
    description: 'שיחה חופשית עם AI - 3 רמות, טבלאות, משימות, מסלולים ועוד',
    color: 'from-blue-500 to-blue-600',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
    options: ['שיחה רגילה', '3 רמות', 'יצירת טבלה', 'משימות', 'זוויות תשובה'],
    price: '0.5-2',
  },
  {
    id: 'transcription' as const,
    icon: Mic,
    title: 'מתמלל',
    description: 'תמלול קבצי אודיו ווידאו - עריכה לעברית, ישיבתית, אידיש',
    color: 'from-purple-500 to-purple-600',
    bgColor: 'bg-purple-50',
    borderColor: 'border-purple-200',
    options: ['תמלול בלבד', 'עריכה לעברית', 'עברית ישיבתית', 'אידיש'],
    price: '1.5/דקה',
  },
  {
    id: 'images' as const,
    icon: Image,
    title: 'מחולל תמונות',
    description: 'יצירה ועריכת תמונות - הסרת רקע, טקסט בעברית, תמונות מוצר',
    color: 'from-pink-500 to-pink-600',
    bgColor: 'bg-pink-50',
    borderColor: 'border-pink-200',
    options: ['יצירת תמונה', 'עריכת תמונה', 'הסרת רקע', 'טקסט בעברית'],
    price: '1-3',
  },
  {
    id: 'typing' as const,
    icon: PenTool,
    title: 'מקליד',
    description: 'הקלדת כתבי יד מתוך PDF, תמונות ו-ZIP עם מסלולי הגהה ועריכה',
    color: 'from-green-500 to-green-700',
    bgColor: 'bg-green-50',
    borderColor: 'border-green-200',
    options: ['הקלדה גולמית', 'כולל הגהה', 'כולל הגהה ועריכה', 'PDF/תמונה/ZIP'],
    price: '14-18/1000',
  },
  {
    id: 'edit' as const,
    icon: FileEdit,
    title: 'אומן הכתב',
    description: 'עיבוד טקסט מתקדם - מקורות תורניים, עריכה, תרגום, OCR',
    color: 'from-amber-500 to-amber-600',
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-200',
    options: ['חיפוש מקורות', 'מאמר תורני', 'עריכה', 'תרגום', 'OCR', 'ניקוד'],
    price: '2-10',
  },
  {
    id: 'code' as const,
    icon: Code,
    title: 'מתכנת',
    description: 'עבודה עם קוד - סוכן מלא, כתיבה, עריכה והסבר קוד',
    color: 'from-emerald-500 to-emerald-600',
    bgColor: 'bg-emerald-50',
    borderColor: 'border-emerald-200',
    options: ['סוכן קוד', 'כותב קוד', 'עורך קוד', 'מסביר קוד'],
    price: '2-5',
  },
];

export function DashboardHome({ onNavigate }: Props) {
  const { user } = useAuthStore();
  const totalBins = (user?.dailyBins || 0) + (user?.monthlyBins || 0);

  return (
    <div style={{ padding: 24 }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1e293b' }}>
          שלום, {user?.name || 'משתמש'}! 👋
        </h1>
        <p style={{ color: '#64748b', marginTop: 4 }}>מה תרצה לעשות היום?</p>
      </div>

      {/* Quick Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 32 }}>
        <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e2e8f0', padding: 16, display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ width: 48, height: 48, background: '#fef3c7', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <TrendingUp style={{ width: 24, height: 24, color: '#d97706' }} />
          </div>
          <div>
            <p style={{ fontSize: 14, color: '#64748b' }}>יתרת בינס'</p>
            <p style={{ fontSize: 24, fontWeight: 700, color: '#1e293b' }}>{totalBins.toFixed(1)}</p>
          </div>
        </div>
        
        <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e2e8f0', padding: 16, display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ width: 48, height: 48, background: '#dbeafe', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Clock style={{ width: 24, height: 24, color: '#2563eb' }} />
          </div>
          <div>
            <p style={{ fontSize: 14, color: '#64748b' }}>שיחות היום</p>
            <p style={{ fontSize: 24, fontWeight: 700, color: '#1e293b' }}>0</p>
          </div>
        </div>
        
        <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e2e8f0', padding: 16, display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ width: 48, height: 48, background: '#d1fae5', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Zap style={{ width: 24, height: 24, color: '#059669' }} />
          </div>
          <div>
            <p style={{ fontSize: 14, color: '#64748b' }}>סטטוס</p>
            <p style={{ fontSize: 18, fontWeight: 700, color: '#059669' }}>מחובר ✓</p>
          </div>
        </div>
      </div>

      {/* Tools Grid */}
      <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1e293b', marginBottom: 16 }}>הכלים שלך</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
        {TOOLS.map((tool) => {
          const Icon = tool.icon;
          const borderColors: Record<string, string> = {
            'border-blue-200': '#bfdbfe',
            'border-purple-200': '#e9d5ff',
            'border-pink-200': '#fbcfe8',
            'border-green-200': '#bbf7d0',
            'border-amber-200': '#fde68a',
            'border-emerald-200': '#a7f3d0',
          };
          const gradients: Record<string, string> = {
            'from-blue-500 to-blue-600': '#3b82f6, #2563eb',
            'from-purple-500 to-purple-600': '#a855f7, #9333ea',
            'from-pink-500 to-pink-600': '#ec4899, #db2777',
            'from-green-500 to-green-700': '#22c55e, #15803d',
            'from-amber-500 to-amber-600': '#f59e0b, #d97706',
            'from-emerald-500 to-emerald-600': '#10b981, #059669',
          };
          const bgColors: Record<string, string> = {
            'bg-blue-50': '#eff6ff',
            'bg-purple-50': '#faf5ff',
            'bg-pink-50': '#fdf2f8',
            'bg-green-50': '#f0fdf4',
            'bg-amber-50': '#fffbeb',
            'bg-emerald-50': '#ecfdf5',
          };
          return (
            <button
              key={tool.id}
              onClick={() => onNavigate(tool.id)}
              style={{
                background: 'white',
                borderRadius: 16,
                border: `2px solid ${borderColors[tool.borderColor] || '#e2e8f0'}`,
                padding: 20,
                textAlign: 'right',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.boxShadow = '0 10px 25px -5px rgba(0,0,0,0.1)';
                e.currentTarget.style.transform = 'translateY(-4px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.boxShadow = 'none';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{
                  width: 48,
                  height: 48,
                  borderRadius: 12,
                  background: `linear-gradient(135deg, ${gradients[tool.color] || '#6366f1, #4f46e5'})`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)',
                }}>
                  <Icon style={{ width: 24, height: 24, color: 'white' }} />
                </div>
                <ArrowLeft style={{ width: 20, height: 20, color: '#cbd5e1' }} />
              </div>
              
              <h3 style={{ fontSize: 18, fontWeight: 700, color: '#1e293b', marginBottom: 4 }}>{tool.title}</h3>
              <p style={{ fontSize: 14, color: '#64748b', marginBottom: 12 }}>{tool.description}</p>
              
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
                {tool.options.slice(0, 3).map((opt) => (
                  <span 
                    key={opt} 
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      padding: '4px 10px',
                      borderRadius: 9999,
                      background: bgColors[tool.bgColor] || '#f1f5f9',
                      color: '#475569',
                    }}
                  >
                    {opt}
                  </span>
                ))}
                {tool.options.length > 3 && (
                  <span style={{
                    fontSize: 12,
                    fontWeight: 600,
                    padding: '4px 10px',
                    borderRadius: 9999,
                    background: '#f1f5f9',
                    color: '#475569',
                  }}>
                    +{tool.options.length - 3}
                  </span>
                )}
              </div>
              
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 12, borderTop: '1px solid #f1f5f9' }}>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>מחיר</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: '#475569' }}>{tool.price} בינס'</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Quick Actions */}
      <div style={{
        marginTop: 32,
        background: 'linear-gradient(135deg, #06b6d4, #2563eb)',
        borderRadius: 16,
        padding: 24,
        color: 'white',
      }}>
        <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>התחל שיחה חדשה</h3>
        <p style={{ color: 'rgba(255,255,255,0.8)', fontSize: 14, marginBottom: 16 }}>
          פשוט כתוב את השאלה שלך והמערכת תנתב אותך לכלי המתאים
        </p>
        <Button
          onClick={() => onNavigate('chat')}
          style={{ background: 'white', color: '#2563eb' }}
        >
          <MessageCircle style={{ width: 16, height: 16, marginLeft: 8 }} />
          התחל עכשיו
        </Button>
      </div>
    </div>
  );
}

export default DashboardHome;
