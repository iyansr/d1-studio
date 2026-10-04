import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';
import { App } from '@/App';
import { applySystemTheme, ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { queryClient } from '@/lib/api';

// Before the first render, so the page doesn't flash light in dark mode.
applySystemTheme();

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <App />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
