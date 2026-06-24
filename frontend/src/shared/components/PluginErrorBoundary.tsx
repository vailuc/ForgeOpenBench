import { Component, type ReactNode } from "react";

interface Props {
  pluginId: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class PluginErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error(`[PluginErrorBoundary] Plugin "${this.props.pluginId}" crashed:`, error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 bg-fob-bg p-8 text-center">
          <div className="text-4xl">⚠️</div>
          <div className="text-lg font-bold text-fob-orange">Plugin crashed</div>
          <div className="max-w-md text-sm text-fob-text-dim">
            <span className="font-mono text-fob-text">{this.props.pluginId}</span> encountered an unexpected error.
            Other plugins and your active session are unaffected.
          </div>
          {this.state.error && (
            <pre className="max-w-lg overflow-auto rounded border border-fob-border bg-fob-surface p-3 text-left text-xs text-fob-red">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleReset}
            className="rounded bg-fob-orange px-4 py-2 text-sm font-semibold text-fob-accent-text hover:opacity-90 transition-opacity"
          >
            Reset Plugin
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
