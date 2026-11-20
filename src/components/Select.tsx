import { Children, isValidElement, type ReactNode } from "react";
import * as Primitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { HarnessMark, PriorityMark } from "./UI";
import type { Harness } from "../shared";

interface Props {
  value: string | number;
  onValueChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}

function OptionIcon({ value }: { value: string }) {
  if (["codex", "claude", "cursor", "copilot", "dsh"].includes(value))
    return <HarnessMark id={value as Harness} small />;
  if (value === "auto")
    return (
      <span className="select-auto-icon">
        <Sparkles size={13} />
      </span>
    );
  if (["high", "medium", "low"].includes(value))
    return (
      <span className="select-priority-icon">
        <PriorityMark value={value} />
      </span>
    );
  return null;
}

export function Select({
  value,
  onValueChange,
  children,
  disabled,
  "aria-label": label,
  className = "",
}: Props) {
  const options = Children.toArray(children)
    .filter(isValidElement)
    .map((element) => {
      const props = element.props as {
        value: string | number;
        children: ReactNode;
        disabled?: boolean;
      };
      return {
        value: String(props.value),
        label: props.children,
        disabled: props.disabled,
      };
    });
  return (
    <Primitive.Root
      value={String(value)}
      onValueChange={onValueChange}
      disabled={disabled}
      onOpenChange={(open) =>
        window.dispatchEvent(
          new CustomEvent("memcode:popover", { detail: open }),
        )
      }
    >
      <Primitive.Trigger
        aria-label={label}
        className={"mc-select-trigger " + className}
      >
        <Primitive.Value />
        <Primitive.Icon className="mc-select-chevron">
          <ChevronDown size={12} />
        </Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          data-memcode-select-open="true"
          className="mc-select-content"
          position="popper"
          sideOffset={6}
          collisionPadding={12}
          align="end"
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <Primitive.ScrollUpButton className="mc-select-scroll">
            <ChevronUp size={12} />
          </Primitive.ScrollUpButton>
          <Primitive.Viewport className="mc-select-viewport">
            <Primitive.Group>
              {label && (
                <Primitive.Label className="mc-select-label">
                  {label}
                </Primitive.Label>
              )}
              {options.map((option) => (
                <Primitive.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="mc-select-item"
                >
                  <OptionIcon value={option.value} />
                  <Primitive.ItemText>{option.label}</Primitive.ItemText>
                  <Primitive.ItemIndicator className="mc-select-indicator">
                    <Check size={13} />
                  </Primitive.ItemIndicator>
                </Primitive.Item>
              ))}
            </Primitive.Group>
          </Primitive.Viewport>
          <Primitive.ScrollDownButton className="mc-select-scroll">
            <ChevronDown size={12} />
          </Primitive.ScrollDownButton>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
