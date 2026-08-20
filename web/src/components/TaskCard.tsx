import { useRef, type DragEvent, type MouseEvent } from "react";
import { TASK_STATUSES, type Task, type TaskPriority, type TaskStatus } from "../types";
import { ActorAvatar } from "./ActorAvatar";
import { LinearIcon, LinearPriorityIcon } from "./LinearIcon";

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "无优先级",
  urgent: "紧急",
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级",
};

function updatedTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function exactTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

interface TaskCardProps {
  task: Task;
  statusIndex: number;
  isDragging: boolean;
  dragShift: number;
  isMoving: boolean;
  isSettling: boolean;
  isContextMenuOpen: boolean;
  onEdit: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onOpenThread: (threadId: string) => void;
}

export function TaskCard({
  task,
  statusIndex,
  isDragging,
  dragShift,
  isMoving,
  isSettling,
  isContextMenuOpen,
  onEdit,
  onContextMenu,
  onMove,
  onDragStart,
  onDragEnd,
  onOpenThread,
}: TaskCardProps) {
  const dragPreviewRef = useRef<HTMLDivElement>(null);
  const dueDate = task.dueDate
    ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(`${task.dueDate}T12:00:00`))
    : null;
  const subIssueTotal = task.relations.subIssues.length;
  const completedSubIssues = task.relations.subIssues.filter((issue) => issue.status === "done").length;
  const activeBlockers = task.relations.blockedBy.filter((issue) => (
    issue.status !== "done" && issue.status !== "canceled"
  )).length;

  function stopThen(callback: () => void) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      callback();
    };
  }

  function setFileDragPreview(event: DragEvent<HTMLElement>) {
    const template = dragPreviewRef.current;
    if (!template) return;
    const preview = template.cloneNode(true) as HTMLDivElement;
    preview.hidden = false;
    preview.classList.add("is-rendering");
    document.body.append(preview);
    event.dataTransfer.setDragImage(preview, preview.offsetWidth / 2, preview.offsetHeight / 2);
    window.setTimeout(() => preview.remove(), 0);
  }

  return (
    <article
      className={`task-card priority-${task.priority}${isDragging ? " is-dragging" : ""}${dragShift ? " is-drag-shifted" : ""}${isMoving ? " is-moving" : ""}${isSettling ? " is-settling" : ""}${isContextMenuOpen ? " is-context-open" : ""}`}
      style={dragShift ? { transform: `translate3d(0, ${dragShift}px, 0)` } : undefined}
      draggable={!isMoving}
      aria-labelledby={`task-${task.id}-title`}
      data-task-id={task.id}
      data-drag-shift={dragShift || undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(task, { x: event.clientX, y: event.clientY });
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
        event.dataTransfer.setData("application/x-taskboard-task", task.id);
        setFileDragPreview(event);
        onDragStart(task, event.currentTarget.offsetHeight);
      }}
      onDragEnd={onDragEnd}
    >
      <div ref={dragPreviewRef} className="task-drag-preview" hidden aria-hidden="true">
        <LinearIcon name="file" />
      </div>
      <button
        className="task-card-open"
        type="button"
        aria-label={`打开 ${task.identifier}: ${task.title}`}
        onClick={() => onEdit(task)}
      />

      <div className="card-topline">
        <span className="card-reference">
          <span className="task-identifier">{task.identifier}</span>
          {task.relations.parent && (
            <>
              <LinearIcon name="chevronRight" />
              <span className="card-parent-title" title={task.relations.parent.title}>
                {task.relations.parent.title}
              </span>
            </>
          )}
        </span>
        <ActorAvatar actor={task.assignee} className="card-assignee-avatar" />
        <div className="card-actions" aria-label="移动议题">
          <button
            className="icon-button compact"
            type="button"
            disabled={statusIndex === 0 || isMoving}
            aria-label="移到上一状态"
            title="移到上一状态"
            onClick={stopThen(() => onMove(task, TASK_STATUSES[statusIndex - 1]))}
          >
            <LinearIcon name="chevronLeft" />
          </button>
          <button
            className="icon-button compact"
            type="button"
            disabled={statusIndex === TASK_STATUSES.length - 1 || isMoving}
            aria-label="移到下一状态"
            title="移到下一状态"
            onClick={stopThen(() => onMove(task, TASK_STATUSES[statusIndex + 1]))}
          >
            <LinearIcon name="chevronRight" />
          </button>
        </div>
      </div>

      <h3 id={`task-${task.id}-title`}>{task.title}</h3>

      <div className="card-properties" aria-label="议题属性">
        <span className={`priority-icon priority-icon-${task.priority}`} title={PRIORITY_LABELS[task.priority]}>
          <LinearPriorityIcon priority={task.priority} />
        </span>
        {activeBlockers > 0 && (
          <span className="blocked-by-count" title={`被 ${activeBlockers} 个未完成议题阻塞`}>
            <LinearIcon name="alert" />
            {activeBlockers}
          </span>
        )}
        {subIssueTotal > 0 && (
          <span className="sub-issue-progress-chip" title={`${completedSubIssues}/${subIssueTotal} 个子议题已完成`}>
            <span className="sub-issue-progress" aria-hidden="true" />
            {completedSubIssues}/{subIssueTotal}
          </span>
        )}
        {task.labels.slice(0, 2).map((label) => (
          <span className="label-chip" key={label}>{label}</span>
        ))}
        {task.labels.length > 2 && (
          <span className="label-more" title={task.labels.slice(2).join(", ")}>+{task.labels.length - 2}</span>
        )}
        {dueDate && (
          <span className="due-date-chip" title={`截止日期 ${task.dueDate}`}>
            <LinearIcon name="calendar" /> {dueDate}
          </span>
        )}
        {task.threadId && (
          <button
            className="thread-link"
            type="button"
            aria-label={`查看对话 ${task.threadId}`}
            title={`查看对话 ${task.threadId}`}
            onClick={stopThen(() => onOpenThread(task.threadId!))}
          >
            <LinearIcon name="conversation" />
          </button>
        )}
        <time
          className="card-updated-at"
          dateTime={task.updatedAt}
          title={`最后修改于 ${exactTime(task.updatedAt)}`}
        >
          更新于 {updatedTime(task.updatedAt)}
        </time>
      </div>
    </article>
  );
}
