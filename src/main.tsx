import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { useSession } from './state/store'
import './styles/theme.css'

import { getProjectToolState, setProjectToolState } from './lib/project'

if (typeof window !== 'undefined') {
  ;(window as unknown as { __useSession: typeof useSession }).__useSession = useSession
  ;(window as unknown as { __setProjectToolState: typeof setProjectToolState }).__setProjectToolState = setProjectToolState
  ;(window as unknown as { __getProjectToolState: typeof getProjectToolState }).__getProjectToolState = getProjectToolState
}

const container = document.getElementById('root')
if (!container) throw new Error('#root fehlt')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
