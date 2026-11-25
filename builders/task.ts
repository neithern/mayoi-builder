// Task (go-task): a project whose tasks are declared in Taskfile.yml.
//
// guess reads top-level keys under tasks: by indentation without a YAML
// dependency, skipping internal tasks. ask runs `task --list-all --json`
// for exact resolution including includes.

import { process, workspace } from "mayoi";
import { matcher, type Builder, type Rough, type Target, type Task } from "./types";

const taskMarkers = ["Taskfile.yml", "Taskfile.yaml"];

const builder: Builder = {
  id: "task",
  markers: taskMarkers,
  guess,
  ask,
  tasks,
};
export default builder;

async function guess(root: string): Promise<Rough | null> {
  let text: string | null = null;
  let file = "";
  for (const name of taskMarkers) {
    text = await read(root + "/" + name);
    if (text !== null) { file = name; break; }
  }
  if (text === null) return null;

  const lines = text.split("\n");
  const targets: Target[] = [];
  const seen = new Set<string>();
  const cmdBodies: string[] = [];

  let inTasks = false;
  let taskIndent = -1;
  let current: { name: string; desc: string; internal: boolean } | null = null;

  const flush = () => {
    if (current && !current.internal && !seen.has(current.name)) {
      seen.add(current.name);
      targets.push({ name: current.name, kind: "recipe", detail: current.desc || file });
    }
    current = null;
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;

    if (!inTasks) {
      if (indent === 0 && /^tasks\s*:\s*$/.test(trimmed)) {
        inTasks = true;
      }
      continue;
    }

    // Left the top-level tasks: block.
    if (indent === 0) {
      flush();
      inTasks = false;
      continue;
    }

    if (taskIndent < 0) taskIndent = indent;

    if (indent === taskIndent) {
      flush();
      const m = trimmed.match(/^["']?([A-Za-z0-9_.:-]+)["']?\s*:/);
      if (m) {
        current = { name: m[1], desc: "", internal: false };
      }
      continue;
    }

    if (current && indent > taskIndent) {
      if (/^internal\s*:\s*true\b/.test(trimmed)) {
        current.internal = true;
      } else {
        const desc = trimmed.match(/^desc\s*:\s*["']?(.+?)["']?\s*$/);
        if (desc && !current.desc) current.desc = desc[1];
        if (trimmed.startsWith("- ") || trimmed.startsWith("cmd:")) {
          cmdBodies.push(trimmed);
        }
      }
    }
  }
  flush();

  const wraps = wrapped(cmdBodies);
  return { targets, wraps: wraps || undefined };
}

function wrapped(bodies: string[]): string {
  const calls: [string, string][] = [
    ["go build", "go"],
    ["go test", "go"],
    ["cargo build", "cargo"],
    ["cargo test", "cargo"],
    ["swift build", "swift"],
    ["xcodebuild", "xcode"],
    ["cmake", "cmake"],
    ["meson", "meson"],
    ["zig build", "zig"],
  ];
  for (const [call, id] of calls) {
    if (bodies.some((b) => b.includes(call))) return id;
  }
  return "";
}

async function ask(root: string): Promise<Target[] | null> {
  try {
    const out = await process.run("task", ["--list-all", "--json"], { cwd: root, timeout: 15000 });
    if (out.code !== 0) return null;
    const parsed = JSON.parse(out.stdout);
    const list: any[] = parsed && Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const targets: Target[] = [];
    for (const item of list) {
      if (!item || typeof item.name !== "string" || !item.name) continue;
      targets.push({
        name: item.name,
        kind: "recipe",
        detail: typeof item.desc === "string" && item.desc ? item.desc : "task",
      });
    }
    return targets.length ? targets : null;
  } catch {
    return null;
  }
}

function tasks(rough: Rough, targets: Target[], isDefault: boolean): Task[] {
  const out: Task[] = [];
  const wraps = rough.wraps || "";
  const names = targets.map((t) => t.name);

  if (names.includes("build")) {
    out.push({
      label: "build",
      type: "process",
      command: "task",
      args: ["build"],
      group: { kind: "build", isDefault },
      detail: wraps ? "task → " + wraps : "task",
      builder: "task",
      problemMatcher: matcher("compilers"),
    });
  }

  for (const target of targets) {
    if (target.name === "build" || target.name === "clean") continue;
    const group = /^(test|check)$|[:_-](test|check)$/.test(target.name)
      ? "test"
      : /^(build|dist)$/.test(target.name)
        ? "build"
        : undefined;
    out.push({
      label: target.name,
      type: "process",
      command: "task",
      args: [target.name],
      group,
      detail: target.detail,
      builder: "task",
      problemMatcher: matcher("compilers"),
    });
  }

  if (names.includes("clean")) {
    out.push({
      label: "clean",
      type: "process",
      command: "task",
      args: ["clean"],
      detail: "task",
      builder: "task",
    });
  }

  return out;
}

async function read(path: string): Promise<string | null> {
  try {
    return await workspace.readFile(path);
  } catch {
    return null;
  }
}
