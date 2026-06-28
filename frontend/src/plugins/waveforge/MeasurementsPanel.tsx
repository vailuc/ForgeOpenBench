import { CollapsibleSection } from "./CollapsibleSection";
import type { MeasurementKey } from "./scopeTypes";
import { ALL_MEASUREMENT_KEYS } from "./scopeTypes";

interface Props {
  ch1Keys: MeasurementKey[];
  ch2Keys: MeasurementKey[];
  onCh1KeysChange: (keys: MeasurementKey[]) => void;
  onCh2KeysChange: (keys: MeasurementKey[]) => void;
}

export function MeasurementsPanel({ ch1Keys, ch2Keys, onCh1KeysChange, onCh2KeysChange }: Props) {
  const toggle = (keys: MeasurementKey[], key: MeasurementKey) =>
    keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];

  return (
    <CollapsibleSection title="Measurements" defaultOpen={false}>
      <div className="text-[10px] text-fob-orange font-bold mb-1">CH1</div>
      <div className="grid grid-cols-2 gap-1 mb-2">
        {ALL_MEASUREMENT_KEYS.map((key) => (
          <label key={`ch1-${key}`} className="flex items-center gap-1 text-[11px] text-fob-text cursor-pointer">
            <input
              type="checkbox"
              checked={ch1Keys.includes(key)}
              onChange={() => onCh1KeysChange(toggle(ch1Keys, key))}
              className="accent-fob-orange"
            />
            {key}
          </label>
        ))}
      </div>
      <div className="text-[10px] text-fob-blue font-bold mb-1">CH2</div>
      <div className="grid grid-cols-2 gap-1">
        {ALL_MEASUREMENT_KEYS.map((key) => (
          <label key={`ch2-${key}`} className="flex items-center gap-1 text-[11px] text-fob-text cursor-pointer">
            <input
              type="checkbox"
              checked={ch2Keys.includes(key)}
              onChange={() => onCh2KeysChange(toggle(ch2Keys, key))}
              className="accent-fob-blue"
            />
            {key}
          </label>
        ))}
      </div>
    </CollapsibleSection>
  );
}
