import { CommandPalette } from './components/CommandPalette'
import { Dashboard } from './components/Dashboard'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ShortcutHelp } from './components/ShortcutHelp'
import { Footer, Header } from './components/AppShell'
import { useFfmpegPrefetch } from './hooks/useFfmpegPrefetch'
import { useGlobalIngest } from './hooks/useGlobalIngest'
import { useKeptSession } from './hooks/useKeptSession'
import { useNewEpisodes } from './hooks/useNewEpisodes'
import { usePanelRoute } from './hooks/usePanelRoute'
import { useTheme } from './hooks/useTheme'
import { WhatsNewDialog, WhatsNewLine } from './components/WhatsNew'

export default function App() {
  const { choice, resolved, setChoice } = useTheme()
  useGlobalIngest()
  useFfmpegPrefetch()
  useKeptSession()
  usePanelRoute()
  useNewEpisodes()

  return (
    <ErrorBoundary>
      <div className="flex min-h-dvh flex-col bg-canvas">
        <Header themeChoice={choice} onThemeChange={setChoice} />
        <WhatsNewLine />
        <main className="flex-1">
          <Dashboard theme={resolved} />
        </main>
        <Footer />
        <CommandPalette />
        <ShortcutHelp />
        <WhatsNewDialog />
      </div>
    </ErrorBoundary>
  )
}
