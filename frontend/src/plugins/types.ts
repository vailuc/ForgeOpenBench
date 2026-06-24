export interface PluginLifecycle {
  mount(container: HTMLElement, bus: PluginBus): void;
  unmount(): void;
  getSettingsSchema?(): Record<string, unknown>;
  applySettings?(settings: Record<string, unknown>): void;
  getToolbarActions?(): ToolbarAction[];
}

export interface PluginBus {
  emit(event: string, payload?: unknown): void;
  on(event: string, handler: (payload: unknown) => void): () => void;
}

export interface ToolbarAction {
  id: string;
  label: string;
  icon?: string;
  handler(): void;
}

export interface PluginDescriptor {
  id: string;
  name: string;
  icon: string;
  load(): Promise<{ default: PluginLifecycle }>;
}
