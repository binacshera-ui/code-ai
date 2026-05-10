import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface User {
  email: string;
  name: string;
  rowNumber?: number;
  isPerUse: boolean;
  dailyBins: number;
  monthlyBins: number;
  subscription?: string;
  driveFolderId?: string;
  imagesFolderId?: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  sessionChecked: boolean;
  
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  logout: () => void;
  checkSharedSession: () => Promise<void>;
  
  updateBins: (daily: number, monthly: number) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isLoading: false,
      error: null,
      sessionChecked: false,
      
      setUser: (user) => set({ user, error: null }),
      setToken: (token) => set({ token }),
      setLoading: (isLoading) => set({ isLoading }),
      setError: (error) => set({ error, isLoading: false }),
      
      logout: () => {
        set({ user: null, token: null, error: null });
        // Clear localStorage
        localStorage.removeItem('code-ai-auth-storage');
      },
      
      // Check if user is logged in via shared session (from main site)
      checkSharedSession: async () => {
        // Don't check if already logged in or already checked
        if (get().user || get().sessionChecked) {
          return;
        }
        
        try {
          set({ isLoading: true });
          
          const response = await fetch('/api/auth/check-session', {
            credentials: 'include',
          });
          
          const data = await response.json();
          
          if (data.authenticated && data.user) {
            // User is logged in via main site - auto-login
            set({
              user: {
                email: data.user.email || '',
                name: data.user.name || 'משתמש',
                isPerUse: false,
                dailyBins: 50,
                monthlyBins: 100,
              },
              sessionChecked: true,
              isLoading: false,
            });
            console.log('✅ Auto-logged in from main site session:', data.source);
          } else {
            set({ sessionChecked: true, isLoading: false });
          }
        } catch (error) {
          console.error('Session check error:', error);
          set({ sessionChecked: true, isLoading: false });
        }
      },
      
      updateBins: (daily, monthly) => set((state) => ({
        user: state.user ? { ...state.user, dailyBins: daily, monthlyBins: monthly } : null
      })),
    }),
    {
      name: 'code-ai-auth-storage',
      partialize: (state) => ({ user: state.user, token: state.token }),
    }
  )
);
