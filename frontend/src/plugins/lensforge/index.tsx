import type { PluginLifecycle, PluginBus } from "../types";
import { createRoot, type Root } from "react-dom/client";
import { LensForgeApp } from "./LensForgeApp";
import { PluginErrorBoundary } from "../../shared/components/PluginErrorBoundary";

class LensForgePlugin implements PluginLifecycle {
  private root?: Root;

  mount(container: HTMLElement, bus: PluginBus): void {
    this.root = createRoot(container);
    this.root.render(<PluginErrorBoundary pluginId="lensforge"><LensForgeApp bus={bus} /></PluginErrorBoundary>);
  }

  unmount(): void {
    this.root?.unmount();
    this.root = undefined;
  }
}

export default LensForgePlugin;
