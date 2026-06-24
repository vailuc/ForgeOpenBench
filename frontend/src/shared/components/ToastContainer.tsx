import { useToasts, type ToastVariant } from "../../shared/hooks/useToastStore";

const variantStyles: Record<ToastVariant, string> = {
  info: "bg-fob-orange/80 border-fob-orange/30 text-fob-accent-text",
  success: "bg-fob-green/80 border-fob-green/30 text-fob-accent-text",
  error: "bg-fob-red/80 border-fob-red/30 text-fob-accent-text",
  warning: "bg-fob-orange/80 border-fob-orange/30 text-fob-accent-text",
};

export function ToastContainer() {
  const toasts = useToasts();
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded border px-3 py-2 text-xs font-mono shadow-lg ${variantStyles[t.variant]}`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
