import { useState, useEffect, FormEvent } from 'react';
import { Eye, EyeOff, AlertCircle, ArrowLeft, Globe } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';

const LANGUAGES = [
  { code: 'he', name: 'עברית', flag: '🇮🇱' },
  { code: 'en', name: 'English', flag: '🇺🇸' },
];

export default function LoginPage() {
  const { setUser } = useAuthStore();
  
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showLangDropdown, setShowLangDropdown] = useState(false);
  const [currentLang, setCurrentLang] = useState('he');
  
  const isRTL = currentLang === 'he';
  
  const changeLanguage = (langCode: string) => {
    setCurrentLang(langCode);
    localStorage.setItem('language', langCode);
    setShowLangDropdown(false);
  };

  useEffect(() => {
    const savedLang = localStorage.getItem('language');
    if (savedLang) setCurrentLang(savedLang);
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch('/api/dashboard/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: username, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Login failed');
      }

      setUser({
        email: data.user.email,
        name: data.user.name,
        isPerUse: data.user.isPerUse || false,
        dailyBins: data.user.dailyBins || 50,
        monthlyBins: data.user.monthlyBins || 100,
      });
    } catch (err: any) {
      console.error(err);
      setError(isRTL ? 'שם משתמש או סיסמה שגויים' : 'Invalid username or password');
    } finally {
      setLoading(false);
    }
  };

  const handleDemoLogin = () => {
    setUsername('demo@example.com');
    setPassword('demo123');
  };

  return (
    <div 
      dir={isRTL ? 'rtl' : 'ltr'}
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'row',
        position: 'relative',
    }}>
      {/* Language Selector */}
      <div style={{ 
        position: 'fixed', 
        top: '20px', 
        insetInlineEnd: '20px',
        zIndex: 1000,
      }}>
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowLangDropdown(!showLangDropdown)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 12px',
              background: 'white',
              border: '1px solid #e5e7eb',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '14px',
              color: '#374151',
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
            }}
          >
            <Globe size={16} />
            {LANGUAGES.find(l => l.code === currentLang)?.name || 'עברית'}
          </button>
          {showLangDropdown && (
            <div style={{
              position: 'absolute',
              top: '100%',
              insetInlineEnd: 0,
              marginTop: '4px',
              background: 'white',
              border: '1px solid #e5e7eb',
              borderRadius: '8px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              overflow: 'hidden',
              zIndex: 100,
              minWidth: '140px',
            }}>
              {LANGUAGES.map(lang => (
                <button
                  key={lang.code}
                  onClick={() => changeLanguage(lang.code)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    width: '100%',
                    padding: '10px 14px',
                    background: currentLang === lang.code ? '#f0f9ff' : 'white',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: '14px',
                    color: '#374151',
                    textAlign: 'start',
                  }}
                >
                  <span>{lang.flag}</span>
                  <span>{lang.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Form Side */}
      <div style={{
        flex: '1',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '40px',
        backgroundColor: '#ffffff',
      }}>
        <div style={{ width: '100%', maxWidth: '400px', textAlign: 'start' }}>
          {/* Logo */}
          <div style={{ textAlign: 'center', marginBottom: '48px' }}>
            <img 
              src="/logo-login.webp" 
              alt="בינה כשרה" 
              style={{ 
                height: '120px',
                width: 'auto',
                maxWidth: '100%',   // לא לחרוג מרוחב האלמנט האב
                objectFit: 'contain',
                margin: '0 auto',
                borderRadius: '24px',
              }} 
            />
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit}>
            {error && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '12px 16px',
                backgroundColor: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: '10px',
                marginBottom: '20px',
                color: '#dc2626',
                fontSize: '14px',
              }}>
                <AlertCircle style={{ width: '18px', height: '18px', flexShrink: 0 }} />
                <span>{error}</span>
              </div>
            )}

            {/* Username */}
            <div style={{ marginBottom: '20px' }}>
              <label style={{
                display: 'block',
                fontSize: '14px',
                fontWeight: '500',
                color: '#374151',
                marginBottom: '8px',
              }}>
                {isRTL ? 'שם משתמש / אימייל' : 'Username / Email'}
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={isRTL ? 'הזן שם משתמש או אימייל' : 'Enter username or email'}
                required
                autoFocus
                style={{
                  width: '100%',
                  padding: '14px 16px',
                  fontSize: '15px',
                  border: '2px solid #e5e7eb',
                  borderRadius: '10px',
                  outline: 'none',
                  transition: 'border-color 0.2s, box-shadow 0.2s',
                  backgroundColor: '#f9fafb',
                  textAlign: isRTL ? 'right' : 'left',
                  direction: isRTL ? 'rtl' : 'ltr',
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = '#4b9eb4';
                  e.target.style.boxShadow = '0 0 0 3px rgba(75, 158, 180, 0.15)';
                  e.target.style.backgroundColor = '#fff';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = '#e5e7eb';
                  e.target.style.boxShadow = 'none';
                  e.target.style.backgroundColor = '#f9fafb';
                }}
              />
            </div>

            {/* Password */}
            <div style={{ marginBottom: '28px', position: 'relative' }}>
              <label style={{
                display: 'block',
                fontSize: '14px',
                fontWeight: '500',
                color: '#374151',
                marginBottom: '8px',
              }}>
                {isRTL ? 'סיסמה' : 'Password'}
              </label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                style={{
                  width: '100%',
                  padding: '14px 16px',
                  paddingInlineStart: '48px',
                  fontSize: '15px',
                  border: '2px solid #e5e7eb',
                  borderRadius: '10px',
                  outline: 'none',
                  transition: 'border-color 0.2s, box-shadow 0.2s',
                  backgroundColor: '#f9fafb',
                  textAlign: isRTL ? 'right' : 'left',
                  direction: isRTL ? 'rtl' : 'ltr',
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = '#4b9eb4';
                  e.target.style.boxShadow = '0 0 0 3px rgba(75, 158, 180, 0.15)';
                  e.target.style.backgroundColor = '#fff';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = '#e5e7eb';
                  e.target.style.boxShadow = 'none';
                  e.target.style.backgroundColor = '#f9fafb';
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  position: 'absolute',
                  insetInlineStart: '14px',
                  top: '42px',
                  background: 'none',
                  border: 'none',
                  color: '#94a3b8',
                  cursor: 'pointer',
                  padding: '4px',
                }}
              >
                {showPassword ? <EyeOff style={{ width: '20px', height: '20px' }} /> : <Eye style={{ width: '20px', height: '20px' }} />}
              </button>
            </div>

            {/* Demo Button */}
            <div style={{ marginBottom: '16px' }}>
              <button
                type="button"
                onClick={handleDemoLogin}
                style={{
                  width: '100%',
                  padding: '12px 16px',
                  fontSize: '14px',
                  fontWeight: '500',
                  color: '#4b9eb4',
                  backgroundColor: '#f0f9ff',
                  border: '2px solid #4b9eb4',
                  borderRadius: '10px',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#e0f2fe';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#f0f9ff';
                }}
              >
                {isRTL ? '🧪 כניסה כמשתמש דמו (לבדיקה)' : '🧪 Demo Login (for testing)'}
              </button>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading}
              style={{
                display: 'flex',
                width: '100%',
                padding: '14px 24px',
                fontSize: '16px',
                fontWeight: '600',
                color: '#ffffff',
                background: 'linear-gradient(135deg, #4b9eb4 0%, #0f212f 100%)',
                border: 'none',
                borderRadius: '10px',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.7 : 1,
                transition: 'transform 0.2s, box-shadow 0.2s',
                boxShadow: '0 4px 14px rgba(75, 158, 180, 0.4)',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              }}
              onMouseEnter={(e) => {
                if (!loading) {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 6px 20px rgba(75, 158, 180, 0.5)';
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = '0 4px 14px rgba(75, 158, 180, 0.4)';
              }}
            >
              {loading ? (
                <>
                  <div style={{
                    width: '20px',
                    height: '20px',
                    border: '2px solid rgba(255,255,255,0.3)',
                    borderTopColor: '#fff',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite',
                  }} />
                  {isRTL ? 'מתחבר...' : 'Connecting...'}
                </>
              ) : (
                <>
                  {isRTL ? 'התחבר למערכת' : 'Login'}
                  <ArrowLeft style={{ width: '18px', height: '18px' }} />
                </>
              )}
            </button>
          </form>

          {/* Footer */}
          <p style={{
            textAlign: 'center',
            fontSize: '13px',
            color: '#94a3b8',
            marginTop: '40px',
          }}>
            © 2024 בינה כשרה. כל הזכויות שמורות.
          </p>
        </div>
      </div>

      {/* Image Side with Animated Overlay */}
      <div style={{
        flex: '1',
        position: 'relative',
        overflow: 'hidden',
        height: '100vh',
      }}>
        {/* Background Image */}
        <img 
          src="/login.png" 
          alt="בינה כשרה" 
          style={{
            position: 'absolute',
            top: 0,
            left: '50%',
            transform: 'translateX(-50%)',
            height: '100%',
            width: 'auto',
            minWidth: '100%',
            objectFit: 'cover',
            objectPosition: 'center',
          }}
          onError={(e) => {
            // Try SVG fallback, then gradient
            const img = e.currentTarget;
            if (img.src.includes('.png')) {
              img.src = '/login.svg';
            } else {
              img.style.display = 'none';
              img.parentElement!.style.background = 'linear-gradient(135deg, #0f212f 0%, #4b9eb4 100%)';
            }
          }}
        />
      </div>

      {/* CSS Animations */}
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        @media (max-width: 768px) {
          .image-side {
            display: none;
          }
        }
      `}</style>
    </div>
  );
}
