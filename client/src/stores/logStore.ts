import { create } from 'zustand';

export interface LogEntry {
  id: string;
  timestamp: Date;
  type: 'request' | 'response' | 'error' | 'info' | 'webhook';
  direction: 'outgoing' | 'incoming';
  endpoint: string;
  method?: string;
  status?: number;
  duration?: number;
  data: any;
  rawPayload?: string;
}

interface LogState {
  logs: LogEntry[];
  isOpen: boolean;
  filter: 'all' | 'request' | 'response' | 'error' | 'webhook';
  addLog: (log: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  clearLogs: () => void;
  togglePanel: () => void;
  setFilter: (filter: LogState['filter']) => void;
}

export const useLogStore = create<LogState>()((set) => ({
  logs: [],
  isOpen: true,
  filter: 'all',
  
  addLog: (log) => set((state) => ({
    logs: [{
      ...log,
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
    }, ...state.logs].slice(0, 500)
  })),
  
  clearLogs: () => set({ logs: [] }),
  
  togglePanel: () => set((state) => ({ isOpen: !state.isOpen })),
  
  setFilter: (filter) => set({ filter }),
}));

export const logRequest = (endpoint: string, method: string, data: any) => {
  useLogStore.getState().addLog({
    type: 'request',
    direction: 'outgoing',
    endpoint,
    method,
    data,
    rawPayload: JSON.stringify(data, null, 2),
  });
};

export const logResponse = (endpoint: string, status: number, data: any, duration: number) => {
  useLogStore.getState().addLog({
    type: 'response',
    direction: 'incoming',
    endpoint,
    status,
    duration,
    data,
    rawPayload: JSON.stringify(data, null, 2),
  });
};

export const logError = (endpoint: string, error: any) => {
  useLogStore.getState().addLog({
    type: 'error',
    direction: 'incoming',
    endpoint,
    data: { message: error.message || error, stack: error.stack },
    rawPayload: JSON.stringify(error, null, 2),
  });
};

export const logWebhook = (endpoint: string, payload: any) => {
  useLogStore.getState().addLog({
    type: 'webhook',
    direction: 'outgoing',
    endpoint,
    data: payload,
    rawPayload: JSON.stringify(payload, null, 2),
  });
};

export const logInfo = (message: string, data?: any) => {
  useLogStore.getState().addLog({
    type: 'info',
    direction: 'incoming',
    endpoint: message,
    data: data || {},
  });
};
