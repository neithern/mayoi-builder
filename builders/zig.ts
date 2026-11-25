// Zig: a project whose build is described by build.zig.
//
// `zig build` always builds the default install step, and custom steps
// (such as `run` and `test`) are declared via `b.step("name", "desc")`.

import { workspace } from "mayoi";
import { matcher, type Builder, type Rough, type Target, type Task } from "./types";

const builder: Builder = {
  id: "zig",
  markers: ["build.zig"],
  guess,
  tasks,
};
export default builder;

async function guess(root: string): Promise<Rough | null> {
  const text = await read(root + "/build.zig");
  if (text === null) return null;

  const targets: Target[] = [];
  const seen = new Set<string>();
  const steps = /\.step\s*\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\)/g;
  let found: RegExpExecArray | null;
  while ((found = steps.exec(text)) !== null) {
    const name = found[1];
    if (!name || name === "install" || name === "uninstall" || seen.has(name)) continue;
    seen.add(name);
    targets.push({
      name,
      kind: "recipe",
      detail: found[2] || "zig step",
    });
  }

  let title: string | undefined;
  const zon = await read(root + "/build.zig.zon");
  if (zon) {
    const m = zon.match(/\.name\s*=\s*(?:\.([A-Za-z_][\w-]*)|"([^"]+)")/);
    if (m) title = m[1] || m[2];
  }

  return { targets, title: title || basename(root) };
}

function tasks(rough: Rough, targets: Target[], isDefault: boolean): Task[] {
  const out: Task[] = [];
  out.push({
    label: "build",
    type: "process",
    command: "zig",
    args: ["build"],
    group: { kind: "build", isDefault },
    detail: "zig",
    builder: "zig",
    problemMatcher: matcher("compilers"),
  });
  out.push({
    label: "build release",
    type: "process",
    command: "zig",
    args: ["build", "-Doptimize=ReleaseSafe"],
    group: "build",
    detail: "zig · ReleaseSafe",
    builder: "zig",
    problemMatcher: matcher("compilers"),
  });

  for (const target of targets) {
    const group = /^(test|check)$|-(test|check)$/.test(target.name) ? "test" : undefined;
    out.push({
      label: target.name,
      type: "process",
      command: "zig",
      args: ["build", target.name],
      group,
      detail: target.detail,
      builder: "zig",
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

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  return at >= 0 ? trimmed.slice(at + 1) : trimmed;
}
