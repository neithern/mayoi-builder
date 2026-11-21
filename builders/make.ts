// Make: a project whose build is a set of recipes in a Makefile.
//
// A target is a name at the start of a line, and .PHONY lists the ones
// that are names of recipes rather than files. Both are read from the
// text: a scan runs no program, and make -qp, while it resolves includes
// and variables more exactly, costs a process and prints a page of noise
// per target.
//
// The one thing the text cannot tell is whether a recipe runs another
// build system, which matters for the order of the panel: a Makefile whose
// build runs xcodebuild is the folder's build. That is read from the
// recipe's own lines.

import { workspace } from "mayoi";
import { matcher, type Builder, type Rough, type Target, type Task } from "./types";

// skipTargets are the names a Makefile has that are not a person's work:
// the file itself, and the ones every Makefile has.
const skipTargets = new Set([
  "Makefile", "makefile", "GNUmakefile",
  "all", "default", "depend", "install", "install/local", "install/strip",
  "list_install_components", "edit_cache", "rebuild_cache", "help",
]);

const builder: Builder = {
  id: "make",
  markers: ["GNUmakefile", "Makefile", "makefile"],
  guess,
  tasks,
};
export default builder;

async function guess(root: string): Promise<Rough | null> {
  let text: string | null = null;
  let file = "";
  for (const name of ["GNUmakefile", "Makefile", "makefile"]) {
    text = await read(root + "/" + name);
    if (text !== null) { file = name; break; }
  }
  if (text === null) return null;

  const targets: Target[] = [];
  const seen = new Set<string>();
  const phony = new Set<string>();
  const declare = /^\.PHONY\s*:\s*(.*)$/m;
  const phonyLine = text.match(declare);
  if (phonyLine) {
    for (const name of phonyLine[1].split(/\s+/)) if (name) phony.add(name);
  }

  const lines = text.split("\n");
  const recipes = new Map<string, string[]>();
  let current = "";
  for (const line of lines) {
    // A recipe line is one that starts with a tab, and belongs to the
    // target above it.
    if (line.startsWith("\t")) {
      if (current && !current.includes("}$")) {
        const list = recipes.get(current) || [];
        list.push(line.slice(1).trim());
        recipes.set(current, list);
      }
      continue;
    }
    if (!line || line.startsWith("#") || line.startsWith("\t")) continue;
    // A target is a name, a colon, and then what it needs.
    const m = line.match(/^([A-Za-z0-9_][\w.-]*)\s*:([^=]|$)/);
    if (!m) { current = ""; continue; }
    const name = m[1];
    current = name;
    if (skipTargets.has(name) || name.startsWith(".")) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    targets.push({ name, kind: "recipe", detail: phony.has(name) ? ".PHONY" : file });
    recipes.set(name, recipes.get(name) || []);
  }

  // A recipe that runs another build system makes this Makefile the
  // folder's build: a project of three build systems builds through the
  // one that names them, and a person running make would get the same.
  // This is for the order alone, and not a thing to show.
  let wraps = "";
  for (const [, list] of recipes) {
    for (const line of list) {
      for (const other of ["xcodebuild", "swift build", "cargo build", "cmake", "meson"]) {
        if (line.includes(other)) { wraps = other; break; }
      }
      if (wraps) break;
    }
    if (wraps) break;
  }

  return { targets, title: file, wraps: wraps || undefined };
}

// tasks are one per target: what make would be given is the target's name,
// and make decides what that runs.
function tasks(rough: Rough, targets: Target[], isDefault: boolean): Task[] {
  const out: Task[] = [];
  const wraps = wrapsOf(rough);
  const names = targets.map((t) => t.name);
  // The build is the target called build, else the first the file has.
  const build = names.includes("build") ? "build" : names[0];
  if (build) {
    out.push({
      label: "build",
      type: "process",
      command: "make",
      args: [build],
      group: { kind: "build", isDefault },
      detail: wraps ? "make → " + wraps : "make · " + build,
      builder: "make",
      problemMatcher: matcher("compilers"),
    });
  }
  for (const target of targets) {
    // The target Build runs is the row named build, and one of its own
    // would say the same thing twice.
    if (target.name === build || target.name === "clean") continue;
    const group = /^(test|check)$|-(test|check)$/.test(target.name)
      ? "test"
      : /^(build|sign|install|release|dist)$/.test(target.name)
        ? "build"
        : undefined;
    out.push({
      label: target.name,
      type: "process",
      command: "make",
      args: [target.name],
      group,
      detail: target.detail,
      builder: "make",
      problemMatcher: matcher("compilers"),
    });
  }
  // clean is only a task when the file has the recipe: a Makefile without
  // one would fail on a target make has no rule for.
  if (targets.some((target) => target.name === "clean")) {
    out.push({
      label: "clean",
      type: "process",
      command: "make",
      args: ["clean"],
      builder: "make",
      problemMatcher: matcher("compilers"),
    });
  }
  return out;
}

// wrapsOf is the other build system this one's recipes run, if any.
function wrapsOf(rough: Rough): string {
  return rough.wraps || "";
}

async function read(path: string): Promise<string | null> {
  try {
    return await workspace.readFile(path);
  } catch {
    return null;
  }
}

