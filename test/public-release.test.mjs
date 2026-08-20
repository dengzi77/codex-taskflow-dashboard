import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

const root = path.resolve(import.meta.dirname, "..");
const source = await readFile(path.join(root, "inject", "codex-taskboard.user.js"), "utf8");
const launcher = await readFile(path.join(root, "scripts", "install-codex-launcher.mjs"), "utf8");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");

let temporaryDirectory;
let app;
let baseUrl;

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-taskflow-release-"));
  app = createTaskboardServer({ dataDirectory: temporaryDirectory });
  const address = await app.listen({ port: 0 });
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app?.close();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

test("public package metadata points at the maintained repository", () => {
  assert.equal(manifest.name, "codex-taskflow-dashboard");
  assert.equal(manifest.version, "1.0.0");
  assert.equal(manifest.license, "MIT");
  assert.match(manifest.repository.url, /dengzi77\/codex-taskflow-dashboard/);
});

test("native board exposes the complete taskflow workflow", () => {
  for (const label of [
    "待处理",
    "正在处理",
    "待验收",
    "已完成",
    "自动化",
    "刷新数据",
    "搜索任务或聊天",
    "加入待处理",
  ]) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /thread\/start/);
  assert.match(source, /turn\/start/);
  assert.match(source, /account\/rateLimits\/read/);
  assert.match(source, /VIEW_STORAGE_KEY/);
});

test("launcher is recoverable and has no unpublished dashboard dependency", () => {
  assert.match(launcher, /\.ChatGPT Official\.app/);
  assert.match(launcher, /io\.github\.dengzi77\.codex-taskflow-dashboard\.launcher/);
  assert.match(launcher, /CODEX_TASKFLOW_DEBUG_PORT/);
  assert.doesNotMatch(launcher, /DASHBOARD_ROOT|DASHBOARD_PORT|dashboard\/package\.json/);
});

test("local data and secrets stay outside Git", () => {
  assert.match(gitignore, /^\.data\/$/m);
  assert.match(gitignore, /^\.dev\.vars\*/m);
  assert.doesNotMatch(source, /\/Users\/standardsoftware|g01z7s2s2nqcb3tmc73vds8h0000gn/);
});

test("local server starts healthy on loopback", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});
