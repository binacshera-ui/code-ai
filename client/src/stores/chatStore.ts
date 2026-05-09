import { create } from 'zustand';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  files?: Array<{
    name: string;
    type: string;
    size: number;
    url?: string;
  }>;
  toolChoice?: string;
  status?: 'sending' | 'sent' | 'error';
}

export interface ChatThread {
  id: string;
  title: string;
  destination: 'chat' | 'edit' | 'code' | 'image' | 'timlul' | 'typing';
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
  status: 'active' | 'completed' | 'error';
}

interface ChatState {
  threads: ChatThread[];
  activeThreadId: string | null;
  isLoading: boolean;
  
  createThread: (destination: ChatThread['destination']) => string;
  setActiveThread: (id: string | null) => void;
  addMessage: (threadId: string, message: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
  updateMessage: (threadId: string, messageId: string, updates: Partial<ChatMessage>) => void;
  updateThread: (threadId: string, updates: Partial<ChatThread>) => void;
  setLoading: (loading: boolean) => void;
  
  getActiveThread: () => ChatThread | undefined;
}

export const useChatStore = create<ChatState>()((set, get) => ({
  threads: [],
  activeThreadId: null,
  isLoading: false,
  
  createThread: (destination) => {
    const id = `thread-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const thread: ChatThread = {
      id,
      title: getDefaultTitle(destination),
      destination,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      status: 'active',
    };
    set((state) => ({ 
      threads: [thread, ...state.threads],
      activeThreadId: id,
    }));
    return id;
  },
  
  setActiveThread: (id) => set({ activeThreadId: id }),
  
  addMessage: (threadId, message) => set((state) => ({
    threads: state.threads.map((t) => 
      t.id === threadId 
        ? {
            ...t,
            messages: [...t.messages, {
              ...message,
              id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              timestamp: new Date(),
            }],
            updatedAt: new Date(),
          }
        : t
    ),
  })),
  
  updateMessage: (threadId, messageId, updates) => set((state) => ({
    threads: state.threads.map((t) => 
      t.id === threadId 
        ? {
            ...t,
            messages: t.messages.map((m) => 
              m.id === messageId ? { ...m, ...updates } : m
            ),
          }
        : t
    ),
  })),
  
  updateThread: (threadId, updates) => set((state) => ({
    threads: state.threads.map((t) => 
      t.id === threadId ? { ...t, ...updates } : t
    ),
  })),
  
  setLoading: (isLoading) => set({ isLoading }),
  
  getActiveThread: () => {
    const state = get();
    return state.threads.find((t) => t.id === state.activeThreadId);
  },
}));

function getDefaultTitle(destination: ChatThread['destination']): string {
  switch (destination) {
    case 'chat': return 'שיחה חדשה';
    case 'edit': return 'עריכה חדשה';
    case 'code': return 'קוד חדש';
    case 'image': return 'תמונה חדשה';
    case 'timlul': return 'תמלול חדש';
    case 'typing': return 'הקלדה חדשה';
  }
}
