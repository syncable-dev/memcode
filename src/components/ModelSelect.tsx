import { cursorCatalogValue } from "../cursor-models";
import type { Harness, ModelOption } from "../shared";
import { Select } from "./Select";

/** Keep the provider's own "auto" option distinct from MemCode's measured route. */
export function ModelSelect({ harness, models, value, automaticLabel, label, disabled, onChange }: {
  harness: Harness;
  models: ModelOption[];
  value?: string | null;
  automaticLabel: string;
  label: string;
  disabled?: boolean;
  onChange: (value: string | null) => void;
}) {
  const selected = value && harness === "cursor" ? cursorCatalogValue(value, models) ?? value : value;
  const listed = models.some(model => model.id === selected);
  const offeredByAlias = models.some(model => model.resolvedId === selected);
  const automatic = "memcode:automatic";
  return <Select aria-label={label} value={selected || automatic} disabled={disabled}
    onValueChange={next => onChange(next === automatic ? null : next)}>
    <option value={automatic}>{automaticLabel}</option>
    {models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
    {selected && !listed && <option value={selected} disabled={!offeredByAlias}>
      {selected}{offeredByAlias ? "" : " · unavailable"}
    </option>}
  </Select>;
}
