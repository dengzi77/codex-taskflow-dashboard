import { useEffect, useRef, useState, type DragEvent } from "react";
import { TASK_STATUSES, type Task, type TaskStatus } from "../types";
import { STATUS_DETAILS, StatusIcon } from "./BoardColumn";
import { LinearIcon } from "./LinearIcon";
import { TaskCard } from "./TaskCard";

export const PRIMARY_BOARD_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
] as const satisfies readonly TaskStatus[];

const DOCK_STATUSES = ["blocked", "done", "canceled"] as const satisfies readonly TaskStatus[];

interface StatusDockProps {
  tasksByStatus: Record<TaskStatus, Task[]>;
  dropTarget: TaskStatus | null;
  draggedTaskId: string | null;
  movingTaskId: string | null;
  settlingTaskId: string | null;
  contextMenuTaskId: string | null;
  onDragTargetChange: (status: TaskStatus | null) => void;
  onDrop: (status: TaskStatus, taskId: string) => void;
  onEdit: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onOpenThread: (threadId: string) => void;
}

export function StatusDock({
  tasksByStatus,
  dropTarget,
  draggedTaskId,
  movingTaskId,
  settlingTaskId,
  contextMenuTaskId,
  onDragTargetChange,
  onDrop,
  onEdit,
  onContextMenu,
  onMove,
  onDragStart,
  onDragEnd,
  onOpenThread,
}: StatusDockProps) {
  const [openStatus, setOpenStatus] = useState<TaskStatus | null>(null);
  const [confirmedStatus, setConfirmedStatus] = useState<TaskStatus | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openStatus) return;

    function closeFromOutside(event: PointerEvent) {
      if (!dockRef.current?.contains(event.target as Node)) setOpenStatus(null);
    }

    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenStatus(null);
    }

    document.addEventListener("pointerdown", closeFromOutside);
    window.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      window.removeEventListener("keydown", closeFromEscape);
    };
  }, [openStatus]);

  function dropTask(event: DragEvent<HTMLElement>, status: TaskStatus) {
    event.preventDefault();
    event.stopPropagation();
    const taskId = event.dataTransfer.getData("application/x-taskboard-task")
      || event.dataTransfer.getData("text/plain");
    onDragTargetChange(null);
    if (!taskId) return;
    setOpenStatus(null);
    setConfirmedStatus(null);
    window.requestAnimationFrame(() => {
      setConfirmedStatus(status);
      window.setTimeout(() => {
        setConfirmedStatus((current) => current === status ? null : current);
      }, 520);
    });
    onDrop(status, taskId);
  }

  const selectedDetails = openStatus ? STATUS_DETAILS[openStatus] : null;
  const selectedTasks = openStatus ? tasksByStatus[openStatus] : [];

  return (
    <div className="status-dock-root" ref={dockRef}>
      {openStatus && selectedDetails && (
        <section className="status-dock-panel" aria-label={`${selectedDetails.label}任务栈`}>
          <header className="status-dock-panel-header">
            <span className={`status-icon status-icon-${selectedDetails.tone}`}>
              <StatusIcon status={openStatus} />
            </span>
            <strong>{selectedDetails.label}</strong>
            <span className="status-dock-panel-count">{selectedTasks.length}</span>
            <button
              type="button"
              className="icon-button status-dock-close"
              aria-label="关闭状态任务栈"
              title="关闭"
              onClick={() => setOpenStatus(null)}
            >
              <LinearIcon name="close" />
            </button>
          </header>
          <div
            className={`status-dock-task-list${dropTarget === openStatus ? " is-drop-target" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              onDragTargetChange(openStatus);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              onDragTargetChange(openStatus);
            }}
            onDragLeave={(event) => {
              if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                onDragTargetChange(null);
              }
            }}
            onDrop={(event) => dropTask(event, openStatus)}
          >
            {selectedTasks.length > 0 ? selectedTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                statusIndex={TASK_STATUSES.indexOf(task.status)}
                isDragging={draggedTaskId === task.id}
                dragShift={0}
                isMoving={movingTaskId === task.id}
                isSettling={settlingTaskId === task.id}
                isContextMenuOpen={contextMenuTaskId === task.id}
                onEdit={onEdit}
                onContextMenu={onContextMenu}
                onMove={onMove}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onOpenThread={onOpenThread}
              />
            )) : (
              <div className="status-dock-empty">暂无{selectedDetails.label}任务</div>
            )}
          </div>
        </section>
      )}

      <nav className="status-dock" aria-label="其他状态">
        {DOCK_STATUSES.map((status) => {
          const details = STATUS_DETAILS[status];
          const taskCount = tasksByStatus[status].length;
          const isOpen = openStatus === status;
          const isDropTarget = dropTarget === status;
          const isDropConfirmed = confirmedStatus === status;
          const hasBlockedTasks = status === "blocked" && taskCount > 0;
          return (
            <button
              type="button"
              className={`status-dock-item status-${status}${hasBlockedTasks ? " has-blocked-tasks" : ""}${isOpen ? " is-open" : ""}${isDropTarget ? " is-drop-target" : ""}${isDropConfirmed ? " is-drop-confirmed" : ""}`}
              key={status}
              aria-pressed={isOpen}
              aria-label={`${details.label}，${taskCount} 个任务`}
              onClick={() => setOpenStatus((current) => current === status ? null : status)}
              onDragEnter={(event) => {
                event.preventDefault();
                onDragTargetChange(status);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                onDragTargetChange(status);
              }}
              onDragLeave={(event) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                  onDragTargetChange(null);
                }
              }}
              onDrop={(event) => dropTask(event, status)}
            >
              <span className={`status-icon status-icon-${details.tone}`}>
                <StatusIcon status={status} />
              </span>
              <span className="status-dock-label">{details.label}</span>
              <span className="status-dock-count">{taskCount}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
