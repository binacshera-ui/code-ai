import { useState } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { logRequest, logResponse, logError } from '@/stores/logStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { 
  Settings, User, Coins, Bell, Shield, Link2, 
  Save, Loader2, ExternalLink, Github, Phone
} from 'lucide-react';

export function SettingsPage() {
  const { user, updateBins, setUser } = useAuthStore();
  const [isSaving, setIsSaving] = useState(false);
  const [formData, setFormData] = useState({
    name: user?.name || '',
    email: user?.email || '',
    githubUsername: '',
    phoneForTranscription: '',
    notifications: {
      email: true,
      completedJobs: true,
      lowBins: true,
    },
  });

  const handleSave = async () => {
    setIsSaving(true);
    try {
      logRequest('/api/dashboard/settings', 'PUT', { ...formData, email: user?.email });

      const response = await fetch('/api/dashboard/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...formData, userEmail: user?.email }),
      });

      const data = await response.json();
      logResponse('/api/dashboard/settings', response.status, data, 0);

      if (response.ok && user) {
        setUser({ ...user, name: formData.name });
      }
    } catch (err: any) {
      logError('/api/dashboard/settings', err);
    } finally {
      setIsSaving(false);
    }
  };

  const totalBins = (user?.dailyBins || 0) + (user?.monthlyBins || 0);

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-slate-500 to-slate-600 rounded-xl flex items-center justify-center">
            <Settings className="w-5 h-5 text-white" />
          </div>
          הגדרות
        </h1>
        <p className="text-slate-500 mt-2">נהל את הפרופיל והחיבורים שלך</p>
      </div>

      {/* Bins Display */}
      <div className="bg-gradient-to-r from-amber-500 to-amber-600 rounded-2xl p-6 mb-6 text-white">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-amber-100 text-sm mb-1">יתרת בינס'</p>
            <p className="text-4xl font-bold">{totalBins.toFixed(1)}</p>
            <div className="flex gap-4 mt-2 text-amber-100 text-sm">
              <span>יומי: {user?.dailyBins?.toFixed(1) || 0}</span>
              <span>חודשי: {user?.monthlyBins?.toFixed(1) || 0}</span>
            </div>
          </div>
          <Button className="bg-white text-amber-600 hover:bg-amber-50">
            <Coins className="w-4 h-4 ml-2" />
            רכוש בינס'
          </Button>
        </div>
      </div>

      {/* Profile Section */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 mb-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
            <User className="w-4 h-4 text-blue-600" />
          </div>
          <h2 className="text-lg font-bold text-slate-800">פרטים אישיים</h2>
        </div>

        <div className="space-y-4">
          <div>
            <Label htmlFor="name">שם מלא</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="mt-1"
            />
          </div>

          <div>
            <Label htmlFor="email">אימייל</Label>
            <Input
              id="email"
              value={formData.email}
              disabled
              className="mt-1 bg-slate-50"
              dir="ltr"
            />
            <p className="text-xs text-slate-400 mt-1">לא ניתן לשנות את האימייל</p>
          </div>
        </div>
      </div>

      {/* Connections Section */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 mb-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
            <Link2 className="w-4 h-4 text-purple-600" />
          </div>
          <h2 className="text-lg font-bold text-slate-800">חיבורים</h2>
        </div>

        <div className="space-y-4">
          <div>
            <Label htmlFor="github" className="flex items-center gap-2">
              <Github className="w-4 h-4" />
              GitHub Username
            </Label>
            <div className="flex gap-2 mt-1">
              <Input
                id="github"
                value={formData.githubUsername}
                onChange={(e) => setFormData({ ...formData, githubUsername: e.target.value })}
                placeholder="your-username"
                dir="ltr"
              />
              <Button variant="outline">
                <ExternalLink className="w-4 h-4" />
              </Button>
            </div>
            <p className="text-xs text-slate-400 mt-1">נדרש לשימוש בסוכן הקוד</p>
          </div>

          <div>
            <Label htmlFor="phone" className="flex items-center gap-2">
              <Phone className="w-4 h-4" />
              טלפון לתמלול
            </Label>
            <Input
              id="phone"
              value={formData.phoneForTranscription}
              onChange={(e) => setFormData({ ...formData, phoneForTranscription: e.target.value })}
              placeholder="050-1234567"
              dir="ltr"
              className="mt-1"
            />
            <p className="text-xs text-slate-400 mt-1">לתמלול טלפוני - התקשר למספר והקלט</p>
          </div>
        </div>
      </div>

      {/* Notifications Section */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 mb-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 bg-emerald-100 rounded-lg flex items-center justify-center">
            <Bell className="w-4 h-4 text-emerald-600" />
          </div>
          <h2 className="text-lg font-bold text-slate-800">התראות</h2>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-slate-800">התראות במייל</p>
              <p className="text-sm text-slate-500">קבל עדכונים על פעולות שהושלמו</p>
            </div>
            <Switch
              checked={formData.notifications.email}
              onCheckedChange={(checked) => 
                setFormData({ 
                  ...formData, 
                  notifications: { ...formData.notifications, email: checked } 
                })
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-slate-800">סיום עבודות</p>
              <p className="text-sm text-slate-500">התראה כשתמלול או עיבוד מסתיים</p>
            </div>
            <Switch
              checked={formData.notifications.completedJobs}
              onCheckedChange={(checked) => 
                setFormData({ 
                  ...formData, 
                  notifications: { ...formData.notifications, completedJobs: checked } 
                })
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-slate-800">יתרת בינס' נמוכה</p>
              <p className="text-sm text-slate-500">התראה כשהיתרה יורדת מתחת ל-10</p>
            </div>
            <Switch
              checked={formData.notifications.lowBins}
              onCheckedChange={(checked) => 
                setFormData({ 
                  ...formData, 
                  notifications: { ...formData.notifications, lowBins: checked } 
                })
              }
            />
          </div>
        </div>
      </div>

      {/* Account Info */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 mb-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center">
            <Shield className="w-4 h-4 text-slate-600" />
          </div>
          <h2 className="text-lg font-bold text-slate-800">פרטי חשבון</h2>
        </div>

        <div className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-500">סוג חשבון</span>
            <Badge className={user?.isPerUse ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}>
              {user?.isPerUse ? 'תשלום לפי שימוש' : 'רגיל'}
            </Badge>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">מנוי</span>
            <span className="text-slate-800">{user?.subscription || 'ללא מנוי'}</span>
          </div>
        </div>
      </div>

      {/* Save Button */}
      <Button
        onClick={handleSave}
        disabled={isSaving}
        className="w-full bg-gradient-to-r from-blue-500 to-blue-600"
      >
        {isSaving ? (
          <>
            <Loader2 className="w-4 h-4 ml-2 animate-spin" />
            שומר...
          </>
        ) : (
          <>
            <Save className="w-4 h-4 ml-2" />
            שמור שינויים
          </>
        )}
      </Button>
    </div>
  );
}

export default SettingsPage;
