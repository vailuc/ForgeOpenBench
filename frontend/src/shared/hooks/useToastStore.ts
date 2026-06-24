/**
 * Lightweight imperative toast system — no external state library needed.
 * Works both inside React components and from plain TS modules.
 */

import { useEffect, useState } from "react";

export type ToastVariant = "info" | "success" | "error" | "warning";

export interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
}

let nextId = 1;
const toasts: Toast[] = [];
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

function push(message: string, variant: ToastVariant = "info", durationMs = 4000): number {
  const id = nextId++;
  toasts.push({ id, message, variant });
  notify();
  if (durationMs > 0) {
    setTimeout(() => dismiss(id), durationMs);
  }
  return id;
}

function dismiss(id: number) {
  const idx = toasts.findIndex((t) => t.id === id);
  if (idx >= 0) {
    toasts.splice(idx, 1);
    notify();
  }
}

export const toast = {
  info: (m: string, d?: number) => push(m, "info", d),
  success: (m: string, d?: number) => push(m, "success", d),
  error: (m: string, d?: number) => push(m, "error", d),
  warning: (m: string, d?: number) => push(m, "warning", d),
  dismiss,
};

export function useToasts(): Toast[] {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((v) => v + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return toasts.slice();
}
