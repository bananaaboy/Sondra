import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { useSession } from './state/store'
import './styles/theme.css'

if (typeof window !== 'undefined') {
  ;(window as unknown as { __useSession: typeof useSession }).__useSession = useSession
}

const container = document.getElementById('root')
if (!container) throw new Error('#root fehlt')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
