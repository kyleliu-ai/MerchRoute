import '@fontsource-variable/noto-sans-sc';
import '@fontsource/ibm-plex-mono/500.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } } });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider theme={{
      token: {
        colorPrimary: '#087F8C', colorInfo: '#087F8C', colorSuccess: '#2D8A64', colorWarning: '#D98B2B', colorError: '#D64545',
        colorText: '#172033', colorTextSecondary: '#5E6C84', colorBgLayout: '#F3F6F8', colorBgContainer: '#FFFFFF',
        borderRadius: 10, fontFamily: '"Noto Sans SC Variable", system-ui, sans-serif'
      },
      components: { Button: { controlHeight: 38 }, Card: { paddingLG: 18 }, Menu: { itemBorderRadius: 8 } }
    }}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter><App /></BrowserRouter>
      </QueryClientProvider>
    </ConfigProvider>
  </React.StrictMode>
);
