import {
  Children,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
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

interface SelectOptionItem {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

interface SelectSection {
  label?: string;
  options: SelectOptionItem[];
}

function flattenElements(children: ReactNode): ReactElement[] {
  const result: ReactElement[] = [];
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue;
    if (child.type === Fragment) {
      result.push(
        ...flattenElements((child.props as { children?: ReactNode }).children),
      );
    } else {
      result.push(child);
    }
  }
  return result;
}

function toOption(element: ReactNode): SelectOptionItem | null {
  if (!isValidElement(element)) return null;
  const props = element.props as {
    value?: string | number;
    children?: ReactNode;
    disabled?: boolean;
  };
  if (props.value === undefined) return null;
  return {
    value: String(props.value),
    label: props.children,
    disabled: props.disabled,
  };
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

function renderOption(option: SelectOptionItem) {
  return (
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
  );
}

export function Select({
  value,
  onValueChange,
  children,
  disabled,
  "aria-label": label,
  className = "",
}: Props) {
  const elements = flattenElements(children);
  const hasOptgroup = elements.some((element) => element.type === "optgroup");
  const flatOptions = hasOptgroup
    ? []
    : elements
        .map(toOption)
        .filter((option): option is SelectOptionItem => option !== null);

  const sections: SelectSection[] = [];
  if (hasOptgroup) {
    for (const element of elements) {
      if (element.type === "optgroup") {
        const props = element.props as { label?: string; children?: ReactNode };
        const groupOptions = flattenElements(props.children)
          .map(toOption)
          .filter((option): option is SelectOptionItem => option !== null);
        if (groupOptions.length > 0) {
          sections.push({
            label: props.label ?? "",
            options: groupOptions,
          });
        }
      } else {
        const option = toOption(element);
        if (!option) continue;
        const last = sections[sections.length - 1];
        if (last && last.label === undefined) last.options.push(option);
        else sections.push({ options: [option] });
      }
    }
  }

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
            {hasOptgroup ? (
              sections.map((section, index) => (
                <Fragment key={section.label ?? `section-${index}`}>
                  {index > 0 && (
                    <Primitive.Separator className="mc-select-separator" />
                  )}
                  <Primitive.Group>
                    {index === 0 && label && (
                      <Primitive.Label className="mc-select-label">
                        {label}
                      </Primitive.Label>
                    )}
                    {section.label && (
                      <Primitive.Label className="mc-select-group-label">
                        {section.label}
                      </Primitive.Label>
                    )}
                    {section.options.map(renderOption)}
                  </Primitive.Group>
                </Fragment>
              ))
            ) : (
              <Primitive.Group>
                {label && (
                  <Primitive.Label className="mc-select-label">
                    {label}
                  </Primitive.Label>
                )}
                {flatOptions.map(renderOption)}
              </Primitive.Group>
            )}
          </Primitive.Viewport>
          <Primitive.ScrollDownButton className="mc-select-scroll">
            <ChevronDown size={12} />
          </Primitive.ScrollDownButton>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
