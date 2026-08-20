import { useEffect, useRef, useState } from "react";
import { TASK_PRIORITIES, type TaskPriority } from "../types";
import { LinearIcon, LinearPriorityIcon } from "./LinearIcon";

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "无优先级",
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

interface PriorityPickerProps {
  value: TaskPriority;
  disabled?: boolean;
  className?: string;
  triggerClassName: string;
  showTriggerIcon?: boolean;
  onChange: (priority: TaskPriority) => void;
}

export function PriorityPicker({
  value,
  disabled = false,
  className = "",
  triggerClassName,
  showTriggerIcon = false,
  onChange,
}: PriorityPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function closeFromEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("keydown", closeFromEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`priority-picker${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`${triggerClassName} priority-picker-trigger`}
        disabled={disabled}
        aria-label={`优先级：${PRIORITY_LABELS[value]}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {showTriggerIcon && (
          <span className={`priority-picker-icon priority-tone-${value}`}>
            <LinearPriorityIcon priority={value} />
          </span>
        )}
        <span className="priority-picker-value">{PRIORITY_LABELS[value]}</span>
        <LinearIcon className="priority-picker-chevron" name="chevronDown" />
      </button>
      {open && (
        <div className="composer-popover priority-popover" role="listbox" aria-label="选择优先级">
          {TASK_PRIORITIES.map((priority) => (
            <button
              type="button"
              role="option"
              aria-selected={priority === value}
              className="priority-option"
              key={priority}
              onClick={() => {
                onChange(priority);
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <span className={`priority-option-icon priority-tone-${priority}`}>
                <LinearPriorityIcon priority={priority} />
              </span>
              <span className="priority-option-label">{PRIORITY_LABELS[priority]}</span>
              {priority === value && (
                <span className="priority-option-check"><LinearIcon name="check" /></span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
