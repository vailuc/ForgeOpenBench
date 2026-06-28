import { toast } from "../../shared/hooks/useToastStore";

const SHORT = 2000;
const NORMAL = 4000;

export function notifyStarted(): void {
  toast.info("Scope running", SHORT);
}

export function notifyStopped(): void {
  toast.info("Scope stopped", SHORT);
}

export function notifySingle(): void {
  toast.info("Single capture armed", SHORT);
}

export function notifyRolling(): void {
  toast.info("Rolling mode", SHORT);
}

export function notifyAveraging(): void {
  toast.info("Averaging mode", SHORT);
}

export function notifyConnected(): void {
  toast.success("Scope connected", NORMAL);
}

export function notifyDisconnected(): void {
  toast.warning("Scope disconnected", NORMAL);
}

export function notifyReferenceSaved(): void {
  toast.success("Reference saved", NORMAL);
}

export function notifyReferenceCleared(): void {
  toast.success("Reference cleared", NORMAL);
}

export function notifyAutoSetDone(): void {
  toast.success("Autoset complete", NORMAL);
}

export function notifyAutoSetFailed(): void {
  toast.error("Autoset failed: no usable signal", NORMAL);
}

export function notifyError(message: string): void {
  toast.error(message, NORMAL);
}
