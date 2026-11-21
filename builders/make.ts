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

  // A recipe that runs another build system says which one the folder
  // really builds with: a project of three build systems builds through
  // one of them, and the tasks that one makes are the ones to offer first.
  // This is for the order alone, and not a thing to show.
  const wraps = wrapped(text);

  // No title: a Makefile names no project, and its own name says only
  // what the file is, which the panel already says. Leaving it empty lets
  // the group be the folder's name, which is the project a person knows.
  return { targets, wraps: wraps || undefined };
}

// wrapped is the build system a Makefile's recipes run, by the name a
// person would type: xcodebuild is Xcode, swift build is Swift, and so on.
// What a recipe does is read from the whole file rather than from each
// target, since a recipe may call a variable that holds the command.
//
// It answers with the build system's id, or "" for one that builds its own,
// and a tool it wraps that this plugin has no reader for counts as none.
function wrapped(text: string): string {
  // The most specific first: "swift build" and "swift package" are Swift,
  // and xcodebuild builds the same project Xcode does.
  const calls: [string, string][] = [
    ["swift build", "swift"],
    ["swift package", "swift"],
    ["swift test", "swift"],
    ["xcodebuild", "xcode"],
    ["cargo build", "cargo"],
    ["cargo test", "cargo"],
    ["meson", "meson"],
    ["cmake", "cmake"],
  ];
  // Only a recipe line counts: a comment naming a tool is not a recipe
  // that runs it, which a Makefile does freely ("extra build settings for
  // xcodebuild"). A recipe is a line that starts with a tab.
  const bodies = text
    .split("\n")
    .filter((line) => line.startsWith("\t"))
    .map((line) => line.replace(/^\t[@-]*/, ""))
    .filter((body) => body && !body.startsWith("#"));
  for (const [call, id] of calls) {
    if (bodies.some((body) => body.includes(call))) return id;
  }
  return "";
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

