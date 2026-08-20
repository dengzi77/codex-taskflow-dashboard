import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AutomationScheduler } from "../server/automation.mjs";
import { TaskboardDatabase } from "../server/database.mjs";

async function waitFor(predicate, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

const ACTOR = { type: "user", id: "local-user", name: "本地用户", avatarUrl: null };

function automationConfig(overrides = {}) {
  return {
    taskboardProjectId: "project",
    codexProjectId: "codex-project",
    projectName: "Project",
    workspacePath: "/fixture/workspace",
    skillPath: "/fixture/skills/manage-taskboard/SKILL.md",
    enabledByUser: true,
    quotaAware: false,
    intervalMinutes: 5,
    model: "gpt-5.5",
    reasoningEffort: "high",
    ...overrides,
  };
}

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-automation-"));
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath);
  const resolvedWorkspace = await realpath(workspacePath);
  const capturePath = path.join(directory, "capture.jsonl");
  const executable = path.join(directory, "fake-codex.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "exec") {
  process.stdin.setEncoding("utf8");
  let prompt = "";
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    setTimeout(() => {
      appendFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify({ args, prompt }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
      process.exit(0);
    }, 120);
  });
}
`);
  await chmod(executable, 0o755);
  const databasePath = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(databasePath);
  database.createProject({ id: "project", name: "Project", workspacePath: resolvedWorkspace });
  return {
    directory,
    database,
    executable,
    capturePath,
    workspacePath: resolvedWorkspace,
  };
}

async function capturedTurns(capturePath) {
  try {
    const content = await readFile(capturePath, "utf8");
    return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function createScheduler(fixture) {
  return new AutomationScheduler({
    database: fixture.database,
    codexExecutable: fixture.executable,
    processEnv: { ...process.env, FAKE_CAPTURE_PATH: fixture.capturePath },
  });
}

async function withFixture(run) {
  const fixture = await createFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

test("a tick with no todo never spawns codex", async () => {
  await withFixture(async (fixture) => {
    fixture.database.upsertProjectAutomation(automationConfig());
    const scheduler = createScheduler(fixture);
    try {
      await scheduler.runOnce("project");
      assert.deepEqual(await capturedTurns(fixture.capturePath), []);
    } finally {
      await scheduler.stop();
    }
  });
});

test("a tick with a todo dispatches one headless codex turn", async () => {
  await withFixture(async (fixture) => {
    fixture.database.upsertProjectAutomation(automationConfig());
    fixture.database.createTask({
      projectId: "project",
      title: "Todo task",
      description: "",
      status: "todo",
      priority: "high",
      labels: [],
      workflowId: null,
      dueDate: null,
      actor: ACTOR,
      assignee: ACTOR,
    });
    const scheduler = createScheduler(fixture);
    try {
      await scheduler.runOnce("project");
      const turns = await waitFor(async () => {
        const current = await capturedTurns(fixture.capturePath);
        return current.length >= 1 ? current : null;
      });
      assert.equal(turns.length, 1);
      const { args, prompt } = turns[0];
      assert.ok(args.includes("-s"), "args should include the sandbox flag");
      assert.ok(args.includes("workspace-write"), "headless dispatch uses the workspace sandbox");
      assert.ok(args.includes("-m"), "args should include the model flag");
      assert.match(prompt, /\[\$manage-taskboard\]/);
      assert.ok(prompt.includes("Project"));
      assert.ok(prompt.includes("project"));
    } finally {
      await scheduler.stop();
    }
  });
});

test("an in-flight dispatch skips a concurrent tick", async () => {
  await withFixture(async (fixture) => {
    fixture.database.upsertProjectAutomation(automationConfig());
    fixture.database.createTask({
      projectId: "project",
      title: "Todo task",
      description: "",
      status: "todo",
      priority: "high",
      labels: [],
      workflowId: null,
      dueDate: null,
      actor: ACTOR,
      assignee: ACTOR,
    });
    const scheduler = createScheduler(fixture);
    try {
      await Promise.all([scheduler.runOnce("project"), scheduler.runOnce("project")]);
      const turns = await waitFor(async () => {
        const current = await capturedTurns(fixture.capturePath);
        return current.length >= 1 ? current : null;
      });
      assert.equal(turns.length, 1, "only one dispatch should spawn");
    } finally {
      await scheduler.stop();
    }
  });
});

test("disabled and deleted configurations stop their timers", async () => {
  await withFixture(async (fixture) => {
    const scheduler = createScheduler(fixture);
    try {
      scheduler.setProjectAutomation(automationConfig());
      assert.ok(scheduler.timers.has("project"), "enabled config schedules a timer");

      scheduler.setProjectAutomation(automationConfig({ enabledByUser: false }));
      assert.equal(scheduler.timers.has("project"), false, "disabled config clears the timer");

      scheduler.setProjectAutomation(automationConfig());
      assert.ok(scheduler.timers.has("project"));

      scheduler.deleteProjectAutomation("project");
      assert.equal(scheduler.timers.has("project"), false, "deleting clears the timer");
    } finally {
      await scheduler.stop();
    }
  });
});

test("start reloads persisted configs and stop clears every timer", async () => {
  await withFixture(async (fixture) => {
    fixture.database.upsertProjectAutomation(automationConfig());
    const scheduler = createScheduler(fixture);
    scheduler.start();
    assert.ok(scheduler.timers.has("project"));
    await scheduler.stop();
    assert.equal(scheduler.timers.size, 0);
  });
});
