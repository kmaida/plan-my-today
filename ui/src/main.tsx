import React from 'react'
import ReactDOM from 'react-dom/client'
import { AuthProvider } from './auth'
import { MCPClientProvider } from './mcp'
import App from './App.tsx'
import './styles/design-tokens.css'
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <MCPClientProvider>
        <App />
      </MCPClientProvider>
    </AuthProvider>
  </React.StrictMode>,
)
