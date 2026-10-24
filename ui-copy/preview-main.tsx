import React from 'react';
import { createRoot } from 'react-dom/client';
import '@original/index.css';
import { installPreviewApi } from './previewApi';

installPreviewApi();

// The production entry registers a service worker; this isolated copy does not.
void import('@original/App').then(({ default: App }) => {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing root');
  createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
});
