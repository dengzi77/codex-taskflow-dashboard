import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skillSource = await readFile(
  new URL("../skills/manage-taskboard/SKILL.md", import.meta.url),
  "utf8",
);

test("the taskboard skill coordinates safe issue execution and review handoff", () => {
  assert.match(skillSource, /`issue get <id>`.*`comment list <id>`/i);
  assert.match(skillSource, /scheduler already claimed.*`in_progress`.*do not rewrite its status/i);
  assert.match(skillSource, /claim one `todo` with its latest version; stop on conflict/i);

  assert.match(
    skillSource,
    /add one concise comment with changes, verification, result, and remaining risk[^\n]*re-read[^\n]*`in_review`[^\n]*latest version/i,
  );
});
