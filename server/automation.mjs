import { readCodexQuotaStatus } from "../scripts/codex-rate-limits.mjs";
import { buildTaskboardAutomationPrompt } from "../shared/taskboard-automation.mjs";
import {
  assignThreadToCodexProject,
  runCodexDesktopTask,
} from "./codex-app-task.mjs";

export class AutomationScheduler {
  constructor({ database, processEnv, onTaskMoved }) {
    this.database = database;
    this.processEnv = processEnv ?? process.env;
    this.onTaskMoved = onTaskMoved ?? (() => {});
    this.codexDebugPort = this.processEnv.CODEX_TASKBOARD_CODEX_DEBUG_PORT ?? "9229";
    this.timers = new Map();
    this.wakeTimers = new Map();
    this.inFlight = new Map();
    this.controllers = new Map();
    this.claimingProjects = new Set();
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    for (const record of this.database.listProjectAutomations()) {
      this.#schedule(record);
    }
  }

  async stop() {
    this.started = false;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    for (const controller of this.controllers.values()) {
      controller.abort(new Error("Taskboard automation stopped"));
    }
    const inFlight = [...this.inFlight.values()].map((entry) => entry.promise);
    if (inFlight.length > 0) {
      await Promise.race([
        Promise.allSettled(inFlight),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 1_000);
          timer.unref();
        }),
      ]);
    }
    this.inFlight.clear();
    this.controllers.clear();
    this.claimingProjects.clear();
  }

  list() {
    return this.database.listProjectAutomations();
  }

  get(taskboardProjectId) {
    return this.database.getProjectAutomation(taskboardProjectId);
  }

  setProjectAutomation(input) {
    const record = this.database.upsertProjectAutomation(input);
    this.#schedule(record);
    return record;
  }

  notifyTaskReady(task) {
    if (task?.status !== "todo") return;
    const record = this.database.getProjectAutomation(task.projectId);
    if (record?.enabledByUser) this.#wake(record);
  }

  deleteProjectAutomation(taskboardProjectId) {
    const timer = this.timers.get(taskboardProjectId);
    if (timer) clearInterval(timer);
    this.timers.delete(taskboardProjectId);
    const wakeTimer = this.wakeTimers.get(taskboardProjectId);
    if (wakeTimer) clearTimeout(wakeTimer);
    this.wakeTimers.delete(taskboardProjectId);
    return this.database.deleteProjectAutomation(taskboardProjectId);
  }

  async runOnce(taskboardProjectId) {
    const record = this.database.getProjectAutomation(taskboardProjectId);
    if (!record) return null;
    return this.#tick(record);
  }

  #schedule(record) {
    const key = record.taskboardProjectId;
    const previous = this.timers.get(key);
    if (previous) clearInterval(previous);
    this.timers.delete(key);
    const pendingWake = this.wakeTimers.get(key);
    if (pendingWake) clearTimeout(pendingWake);
    this.wakeTimers.delete(key);
    if (!record.enabledByUser) return;
    const timer = setInterval(
      () => void this.#tick(record),
      record.intervalSeconds * 1_000,
    );
    timer.unref();
    this.timers.set(key, timer);
    this.#wake(record);
  }

  #wake(record) {
    const key = record.taskboardProjectId;
    if (this.wakeTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.wakeTimers.delete(key);
      void this.#tick(record);
    }, 0);
    timer.unref();
    this.wakeTimers.set(key, timer);
  }

  async #tick(record) {
    const key = record.taskboardProjectId;
    if (this.claimingProjects.has(key)) return;
    this.claimingProjects.add(key);
    const dispatches = [];
    try {
      if (record.quotaAware) {
        const quota = await readCodexQuotaStatus(record.model);
        if (quota?.state !== "available") return;
      }
      const availableSlots = record.concurrencyLimit - this.#projectInFlightCount(key);
      if (availableSlots <= 0) return;
      const candidates = this.database.listTasks({
        projectId: key,
        status: "todo",
        archived: "false",
      }).slice(0, availableSlots);
      for (const candidate of candidates) {
        const claimed = this.database.moveTask(
          candidate.id,
          candidate.version,
          "in_progress",
          undefined,
          candidate.threadId,
        );
        this.onTaskMoved(claimed);
        const dispatch = this.#dispatch(record, claimed)
          .catch((error) => {
            console.error(`Taskboard automation tick failed for ${key}: ${error.message}`);
          })
          .finally(() => {
            this.inFlight.delete(claimed.id);
          });
        this.inFlight.set(claimed.id, { projectId: key, promise: dispatch });
        dispatches.push(dispatch);
      }
    } catch (error) {
      console.error(`Taskboard automation tick failed for ${key}: ${error.message}`);
    } finally {
      this.claimingProjects.delete(key);
    }
    await Promise.all(dispatches);
  }

  async #dispatch(record, candidate) {
    const request = {
      taskboardProjectId: record.taskboardProjectId,
      codexProjectId: record.codexProjectId,
      projectName: record.projectName,
      workspacePath: record.workspacePath,
      skillPath: record.skillPath,
      taskId: candidate.id,
      taskIdentifier: candidate.identifier,
      intervalSeconds: record.intervalSeconds,
      model: record.model,
      reasoningEffort: record.reasoningEffort,
    };
    const prompt = buildTaskboardAutomationPrompt(request);
    const controller = new AbortController();
    this.controllers.set(candidate.id, controller);
    try {
      const result = await runCodexDesktopTask({
        debugPort: this.codexDebugPort,
        workspacePath: record.workspacePath,
        model: record.model,
        reasoningEffort: record.reasoningEffort,
        sandbox: record.sandbox,
        title: `${candidate.identifier} · ${candidate.title}`,
        prompt,
        signal: controller.signal,
        onThreadStarted: async (threadId) => {
          const current = this.database.getTask(candidate.id);
          if (current?.status !== "in_progress") {
            throw new Error(`Task ${candidate.identifier} is no longer in progress`);
          }
          this.database.updateTask(current.id, current.version, {}, threadId);
          await assignThreadToCodexProject({
            debugPort: this.codexDebugPort,
            threadId,
            projectId: record.codexProjectId,
            cwd: record.workspacePath,
          });
        },
      });
      if (result.status !== "completed") {
        console.error(
          `Taskboard automation dispatch failed for ${record.taskboardProjectId} `
          + `(${result.status ?? "unknown"})${result.error ? `: ${JSON.stringify(result.error)}` : ""}`,
        );
        return;
      }
      const current = this.database.getTask(candidate.id);
      if (current?.status === "in_progress") {
        this.database.moveTask(current.id, current.version, "in_review", undefined, current.threadId);
      }
    } finally {
      this.controllers.delete(candidate.id);
    }
  }

  #projectInFlightCount(projectId) {
    let count = 0;
    for (const entry of this.inFlight.values()) {
      if (entry.projectId === projectId) count += 1;
    }
    return count;
  }
}
