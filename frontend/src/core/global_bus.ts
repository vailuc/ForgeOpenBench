/**
 * global_bus — singleton cross-plugin event bus.
 * Used for plugin-to-plugin messages that don't go through App.tsx routing.
 * Examples: noteforge.insert, noteforge.refresh, workspace.project.changed
 */

type Handler = (payload: unknown) => void;

class GlobalBus {
  private handlers = new Map<string, Set<Handler>>();

  emit(event: string, payload?: unknown): void {
    this.handlers.get(event)?.forEach((h) => h(payload));
  }

  on(event: string, handler: Handler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }
}

export const globalBus = new GlobalBus();
