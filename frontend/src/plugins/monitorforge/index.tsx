import { createRoot, type Root } from "react-dom/client";
import { PluginErrorBoundary } from "../../shared/components/PluginErrorBoundary";
import type { PluginLifecycle, PluginBus } from "../types";
import { MonitorForgeApp } from "./MonitorForgeApp";

class MonitorForgePlugin implements PluginLifecycle {
  private root: Root | null = null;

  mount(container: HTMLElement, bus: PluginBus): void {
    this.root = createRoot(container);
    this.root.render(
      <PluginErrorBoundary pluginId="monitorforge">
        <MonitorForgeApp bus={bus} />
      </PluginErrorBoundary>
    );
  }

  unmount(): void {
    this.root?.unmount();
    this.root = null;
  }
}

export default function createPlugin(): PluginLifecycle {
  return new MonitorForgePlugin();
}
