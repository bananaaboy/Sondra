import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, Card } from './ui/primitives'

interface Props {
  children: ReactNode
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode)
  panel?: string
  onReset?: () => void
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: ErrorInfo | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo })
    console.error('[Sondra ErrorBoundary]', error, errorInfo)
  }

  override componentDidUpdate(prevProps: Props) {
    if (prevProps.panel !== this.props.panel && this.state.hasError) {
      this.setState({ hasError: false, error: null, errorInfo: null })
    }
  }

  reset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null })
    this.props.onReset?.()
  }

  override render() {
    if (!this.state.hasError || !this.state.error) {
      return this.props.children
    }

    const { error, errorInfo } = this.state
    const { fallback, panel } = this.props

    if (typeof fallback === 'function') {
      return fallback(error, this.reset)
    }
    if (fallback) {
      return fallback
    }

    // Panel-level fallback
    if (panel) {
      return (
        <Card tone="slate" className="rise my-[24px]">
          <div className="flex flex-col gap-[16px] p-[8px]">
            <div className="flex flex-col gap-[4px]">
              <h2 className="text-subheading font-semibold text-ink">
                Werkzeug fehlgeschlagen
              </h2>
              <p className="text-body leading-[1.55] text-prose/85">
                Im Werkzeug {panel ? `„${panel}“` : ''} ist ein unerwarteter Fehler aufgetreten. Die restliche Anwendung läuft weiter und Ihre Sitzung bleibt erhalten.
              </p>
            </div>

            {error.message ? (
              <div className="rounded-card bg-panel-soft p-[12px] font-mono text-small text-ink">
                {error.message}
              </div>
            ) : null}

            {errorInfo?.componentStack ? (
              <details className="text-small text-muted">
                <summary className="press cursor-pointer select-none py-[4px] hover:text-ink">
                  Details anzeigen
                </summary>
                <pre className="mt-[8px] max-h-[200px] overflow-auto whitespace-pre-wrap rounded-card bg-canvas p-[12px] font-mono text-micro text-prose/70">
                  {errorInfo.componentStack}
                </pre>
              </details>
            ) : null}

            <div className="flex flex-wrap items-center gap-[12px] pt-[8px]">
              <Button variant="primary" onClick={this.reset}>
                Erneut versuchen
              </Button>
              <Button
                variant="quiet"
                onClick={() => {
                  this.reset()
                  window.location.hash = '#/'
                }}
              >
                Zur Startseite
              </Button>
            </div>
          </div>
        </Card>
      )
    }

    // App-level fallback
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas p-[24px] text-prose">
        <div className="w-full max-w-[600px] rounded-card bg-raised p-[32px] ring-1 ring-inset ring-line elevate-plate">
          <h1 className="text-subheading font-bold text-ink">
            Ein unerwarteter Fehler ist aufgetreten
          </h1>
          <p className="mt-[12px] text-body leading-[1.55] text-prose/85">
            Sondra ist auf ein unerwartetes Problem gestoßen. Keine Sorge: Ihre Dateien auf dem Rechner wurden nicht verändert.
          </p>

          {error.message ? (
            <div className="mt-[16px] rounded-card bg-panel-soft p-[12px] font-mono text-small text-ink">
              {error.message}
            </div>
          ) : null}

          {errorInfo?.componentStack ? (
            <details className="mt-[16px] text-small text-muted">
              <summary className="press cursor-pointer select-none py-[4px] hover:text-ink">
                Details anzeigen
              </summary>
              <pre className="mt-[8px] max-h-[200px] overflow-auto whitespace-pre-wrap rounded-card bg-canvas p-[12px] font-mono text-micro text-prose/70">
                {errorInfo.componentStack}
              </pre>
            </details>
          ) : null}

          <div className="mt-[24px] flex flex-wrap items-center gap-[12px]">
            <Button variant="primary" onClick={this.reset}>
              Erneut versuchen
            </Button>
            <Button variant="quiet" onClick={() => window.location.reload()}>
              Seite neu laden
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
