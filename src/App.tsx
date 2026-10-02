import { CommandPalette } from './components/CommandPalette'
import { Dashboard } from './components/Dashboard'
import { ShortcutHelp } from './components/ShortcutHelp'
import { DropOverlay, Footer, Header } from './components/AppShell'
import { useFfmpegPrefetch } from './hooks/useFfmpegPrefetch'
import { useGlobalIngest } from './hooks/useGlobalIngest'
import { useKeptSession } from './hooks/useKeptSession'
import { usePanelRoute } from './hooks/usePanelRoute'
import { useTheme } from './hooks/useTheme'

export default function App() {
  const { choice, resolved, setChoice } = useTheme()
  const { dragging } = useGlobalIngest()
  useFfmpegPrefetch()
  useKeptSession()
  usePanelRoute()

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <Header themeChoice={choice} onThemeChange={setChoice} />
      <main className="flex-1">
        <Dashboard theme={resolved} />
      </main>
      <Footer />
      <DropOverlay visible={dragging} />
      <CommandPalette />
      <ShortcutHelp />
    </div>
  )
}
