import { useState, useEffect } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { 
  MessageCircle, Mic, Image, FileEdit, Code, PenTool,
  LayoutDashboard, History, Settings, LogOut,
  Coins, ChevronLeft, Menu, User
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DebugPanel } from './DebugPanel';

import { 
  DashboardHome, ChatPage, TranscriptionPage, 
  TypingPage, ImageStudioPage, EditPage, CodePage, 
  HistoryPage, SettingsPage, LoginPage 
} from '@/pages';

type PageType = 'home' | 'chat' | 'transcription' | 'typing' | 'images' | 'edit' | 'code' | 'history' | 'settings';

const TOOLS = [
  { id: 'home' as const, icon: LayoutDashboard, label: 'דשבורד', color: 'text-slate-600' },
  { id: 'chat' as const, icon: MessageCircle, label: 'משוחח', color: 'text-blue-600' },
  { id: 'transcription' as const, icon: Mic, label: 'מתמלל', color: 'text-purple-600' },
  { id: 'typing' as const, icon: PenTool, label: 'מקליד', color: 'text-green-600' },
  { id: 'images' as const, icon: Image, label: 'מחולל תמונות', color: 'text-pink-600' },
  { id: 'edit' as const, icon: FileEdit, label: 'אומן הכתב', color: 'text-amber-600' },
  { id: 'code' as const, icon: Code, label: 'מתכנת', color: 'text-emerald-600' },
];

const BOTTOM_NAV = [
  { id: 'history' as const, icon: History, label: 'היסטוריה' },
  { id: 'settings' as const, icon: Settings, label: 'הגדרות' },
];

export function AppDashboard() {
  const { user, logout, isLoading, sessionChecked, checkSharedSession } = useAuthStore();
  const [activePage, setActivePage] = useState<PageType>('home');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Check for shared session from main site on mount
  useEffect(() => {
    checkSharedSession();
  }, [checkSharedSession]);

  // Show loading while checking session
  if (isLoading && !sessionChecked) {
    return (
      <div style={{ minHeight: '100vh', background: '#f0f4f8', display: 'flex', alignItems: 'center', justifyContent: 'center', direction: 'rtl' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 48, height: 48, border: '4px solid #e2e8f0', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 16px' }} />
          <p style={{ color: '#64748b' }}>בודק התחברות...</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  const totalBins = (user.dailyBins || 0) + (user.monthlyBins || 0);

  return (
    <div style={{ minHeight: '100vh', background: '#f0f4f8', direction: 'rtl' }}>
      {/* Sidebar */}
      <aside 
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          height: '100vh',
          background: 'white',
          borderLeft: '1px solid #e2e8f0',
          boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.1)',
          transition: 'all 0.3s',
          zIndex: 40,
          width: sidebarCollapsed ? 64 : 256,
        }}
      >
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottom: '1px solid #e2e8f0' }}>
          {!sidebarCollapsed && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 32,
                height: 32,
                background: 'linear-gradient(135deg, #06b6d4, #2563eb)',
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <span style={{ color: 'white', fontWeight: 700, fontSize: 14 }}>ב</span>
              </div>
              <span style={{ fontWeight: 700, color: '#1e293b' }}>בינה כשרה</span>
            </div>
          )}
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            style={{ padding: 6, borderRadius: 8, cursor: 'pointer', background: 'transparent', border: 'none' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#f1f5f9'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            {sidebarCollapsed ? <Menu style={{ width: 20, height: 20 }} /> : <ChevronLeft style={{ width: 20, height: 20 }} />}
          </button>
        </div>

        {/* Bins Display */}
        <div style={{
          padding: 12,
          margin: sidebarCollapsed ? '12px 8px' : '12px',
          background: 'linear-gradient(135deg, #fef3c7, #fde68a)',
          borderRadius: 12,
          border: '1px solid #fde68a',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: sidebarCollapsed ? 'center' : 'flex-start', gap: sidebarCollapsed ? 0 : 8 }}>
            <Coins style={{ width: 20, height: 20, color: '#d97706' }} />
            {!sidebarCollapsed && (
              <div>
                <p style={{ fontSize: 12, color: '#b45309' }}>יתרת בינס'</p>
                <p style={{ fontSize: 18, fontWeight: 700, color: '#92400e' }}>{totalBins.toFixed(1)}</p>
              </div>
            )}
          </div>
        </div>

        {/* Tools Navigation */}
        <nav style={{ padding: 12 }}>
          {TOOLS.map((tool) => {
            const Icon = tool.icon;
            const isActive = activePage === tool.id;
            return (
              <button
                key={tool.id}
                onClick={() => setActivePage(tool.id)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: sidebarCollapsed ? '10px 8px' : '10px 12px',
                  borderRadius: 12,
                  marginBottom: 4,
                  border: 'none',
                  cursor: 'pointer',
                  justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                  background: isActive ? '#f1f5f9' : 'transparent',
                  color: isActive ? '#0f172a' : '#475569',
                  transition: 'all 0.2s',
                  boxShadow: isActive ? '0 1px 2px 0 rgb(0 0 0 / 0.05)' : 'none',
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = '#f8fafc'; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                title={sidebarCollapsed ? tool.label : undefined}
              >
                  <Icon style={{ width: 20, height: 20, color: tool.color.replace('text-', '') === 'slate-600' ? '#475569' : tool.color.includes('blue') ? '#2563eb' : tool.color.includes('purple') ? '#9333ea' : tool.color.includes('green') ? '#15803d' : tool.color.includes('pink') ? '#db2777' : tool.color.includes('amber') ? '#d97706' : '#059669' }} />
                {!sidebarCollapsed && (
                  <span style={{ fontWeight: 500, fontSize: 14 }}>{tool.label}</span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Divider */}
        <div style={{ margin: '8px 12px', borderTop: '1px solid #e2e8f0' }} />

        {/* Bottom Navigation */}
        <nav style={{ padding: 12 }}>
          {BOTTOM_NAV.map((item) => {
            const Icon = item.icon;
            const isActive = activePage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActivePage(item.id)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: sidebarCollapsed ? '10px 8px' : '10px 12px',
                  borderRadius: 12,
                  marginBottom: 4,
                  border: 'none',
                  cursor: 'pointer',
                  justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
                  background: isActive ? '#f1f5f9' : 'transparent',
                  color: isActive ? '#0f172a' : '#64748b',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = '#f8fafc'; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                title={sidebarCollapsed ? item.label : undefined}
              >
                <Icon style={{ width: 20, height: 20 }} />
                {!sidebarCollapsed && (
                  <span style={{ fontWeight: 500, fontSize: 14 }}>{item.label}</span>
                )}
              </button>
            );
          })}
        </nav>

        {/* User Section */}
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: 12,
          borderTop: '1px solid #e2e8f0',
          background: 'white',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: sidebarCollapsed ? 'center' : 'flex-start', gap: sidebarCollapsed ? 0 : 12 }}>
            <div style={{
              width: 36,
              height: 36,
              background: '#e2e8f0',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <User style={{ width: 20, height: 20, color: '#475569' }} />
            </div>
            {!sidebarCollapsed && (
              <>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 14, fontWeight: 500, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.name || user.email}</p>
                  <p style={{ fontSize: 12, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</p>
                </div>
                <button
                  onClick={logout}
                  style={{
                    padding: 8,
                    borderRadius: 8,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    color: '#94a3b8',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = '#ef4444';
                    e.currentTarget.style.background = '#fef2f2';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = '#94a3b8';
                    e.currentTarget.style.background = 'transparent';
                  }}
                  title="התנתק"
                >
                  <LogOut style={{ width: 16, height: 16 }} />
                </button>
              </>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main 
        style={{
          transition: 'all 0.3s',
          marginRight: sidebarCollapsed ? 64 : 256,
          minHeight: '100vh',
          paddingBottom: '45vh',
        }}
      >
        {activePage === 'home' && <DashboardHome onNavigate={setActivePage} />}
        {activePage === 'chat' && <ChatPage />}
        {activePage === 'transcription' && <TranscriptionPage />}
        {activePage === 'typing' && <TypingPage />}
        {activePage === 'images' && <ImageStudioPage />}
        {activePage === 'edit' && <EditPage />}
        {activePage === 'code' && <CodePage />}
        {activePage === 'history' && <HistoryPage />}
        {activePage === 'settings' && <SettingsPage />}
      </main>

      {/* Debug Panel */}
      <DebugPanel />
    </div>
  );
}

export default AppDashboard;
