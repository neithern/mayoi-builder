// npm: a project whose build is the scripts its package.json names,
// which is the one build system whose tasks are all in a file that says
// exactly what they are.
//
// There is nothing to guess and nothing to ask: a script is a name and a
// line, and the file has both. What is worth reading is which package
// manager the folder uses, since a lockfile is the truth about that and a
// script run by the wrong one resolves different modules.

import { workspace } from "mayoi";
import { matcher, type Builder, type Note, type Rough, type Target, type Task } from "./types";

const builder: Builder = {
  id: "npm",
  markers: ["package.json"],
  guess,
  tasks,
};
export default builder;

// managers are the package managers a lockfile names, and the command each
// runs a script with.
const managers: { lock: string; command: string }[] = [
  { lock: "pnpm-lock.yaml", command: "pnpm" },
  { lock: "yarn.lock", command: "yarn" },
  { lock: "bun.lockb", command: "bun" },
  { lock: "package-lock.json", command: "npm" },
];

async function guess(root: string): Promise<Rough | null> {
  const text = await read(root + "/package.json");
  if (text === null) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // A package.json that does not parse is a folder with a broken file,
    // and saying so is better than a panel that shows nothing.
    return { targets: [], notes: [{ key: "broken", subject: "package.json" }] };
  }
  const scripts = parsed && parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
  const targets: Target[] = [];
  for (const name of Object.keys(scripts)) {
    targets.push({ name, kind: "recipe", detail: "script" });
  }
  // The lockfile says which package manager the folder was installed with,
  // and a script run by another resolves other modules: a pnpm folder run
  // by npm finds a node_modules that is not the one it was set up with.
  let manager = "npm";
  for (const one of managers) {
    if (await exists(root + "/" + one.lock)) {
      manager = one.command;
      break;
    }
  }
  // A package.json with no scripts has nothing to build: that is not a
  // fault to report, and the panel says the same of a folder with no build.
  const notes: Note[] = [];
  return {
    targets,
    title: typeof parsed.name === "string" ? parsed.name : undefined,
    notes,
    // The package manager rides on the rough result for the tasks to read:
    // it is not a target, and it is not something to show.
    tool: manager === "npm" ? undefined : manager,
  };
}

// tasks are one per script: what npm run would be given is the script's
// name, and npm decides what that runs.
function tasks(rough: Rough, targets: Target[], isDefault: boolean): Task[] {
  const manager = rough.tool || "npm";
  const names = targets.map((t) => t.name);
  const out: Task[] = [];
  // A script called build, then dev, then start, is the one Build runs; a
  // folder with none of them has no build to make the default.
  const build = ["build", "compile", "bundle"].find((n) => names.includes(n));
  if (build) {
    out.push({
      label: "build",
      type: "process",
      command: manager,
      args: ["run", build],
      group: { kind: "build", isDefault },
      detail: manager + " · " + build,
      builder: "npm",
      problemMatcher: matcher("compilers"),
    });
  }
  for (const target of targets) {
    if (target.name === build) continue;
    const group = /^(test|check|lint)$|^(test|check|lint):/.test(target.name)
      ? "test"
      : /^(build|compile|bundle|release|dist)$/.test(target.name)
        ? "build"
        : undefined;
    out.push({
      label: target.name,
      type: "process",
      command: manager,
      args: ["run", target.name],
      group,
      detail: manager,
      builder: "npm",
      problemMatcher: matcher("compilers"),
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

async function exists(path: string): Promise<boolean> {
  try {
    const info = await workspace.stat(path);
    return !!info && !info.isDir;
  } catch {
    return false;
  }
}
