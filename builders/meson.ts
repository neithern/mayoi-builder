// Meson: a project whose build is described by meson.build, and whose
// targets are executable() and library() calls, often in a subdirectory.
//
// A scan reads the files and follows subdir(), because meson introspect
// --ast takes only the root of a project: given src/meson.build it says
// "Not the project root", which is exactly the file a target tends to be
// in. And the target's name is usually a variable, whose value may be
// meson.project_name(), which is the project's own name and not a string
// anywhere in the file. Following that is the work of this file.

import { workspace } from "mayoi";
import { matcher, type Builder, type Note, type Rough, type Target, type Task } from "./types";

const subdirLimit = 6;
const subdirDepth = 2;
// assignHops is how many assignments a name is followed through, as
// c_name = project_name or app = c_name.
const assignHops = 3;

const builder: Builder = {
  id: "meson",
  markers: ["meson.build"],
  guess,
  tasks,
};
export default builder;

async function guess(root: string): Promise<Rough | null> {
  const first = await read(root + "/meson.build");
  if (first === null) return null;
  const notes: Note[] = [];
  const targets: Target[] = [];
  const seen = new Set<string>();
  let title: string | undefined;
  let budget = subdirLimit;

  const walk = async (dir: string, depth: number) => {
    const text = dir === root ? first : await read(dir + "/meson.build");
    if (text === null) return;
    // The project's name is read at the root and is what subdirs mean by
    // meson.project_name(), which is how a target is usually named.
    const parsed = parse(text, title);
    title = title || parsed.title;
    for (const target of parsed.targets) {
      if (seen.has(target.name)) continue;
      seen.add(target.name);
      targets.push(target);
    }
    if (depth >= subdirDepth) return;
    for (const sub of parsed.subdirs) {
      const there = await stat(dir + "/" + sub + "/meson.build");
      if (!there) {
        notes.push({ key: "unparsed", subject: sub });
        continue;
      }
      if (budget <= 0) {
        notes.push({ key: "unparsed", subject: sub });
        continue;
      }
      budget--;
      await walk(join(dir, sub), depth + 1);
    }
  };

  await walk(root, 0);
  return { targets, title: title || basename(root), notes };
}

// parse reads one meson.build: the project() call, the targets it declares
// and the folders it goes into.
function parse(text: string, projectName?: string): { title?: string; targets: Target[]; subdirs: string[] } {
  const clean = stripComments(text);
  const vars = symbols(clean);
  let title: string | undefined;
  const project = clean.match(/\bproject\s*\(\s*'([^']+)'/);
  if (project) title = project[1];
  const targets: Target[] = [];
  // executable(name, ...), library(name, ...), shared_library, static_library.
  const calls = /\b(executable|library|shared_library|static_library|both_libraries)\s*\(\s*([^,\s)]+)/g;
  let found: RegExpExecArray | null;
  while ((found = calls.exec(clean)) !== null) {
    const raw = found[2].trim();
    const resolved = value(raw, vars, 0, title || projectName);
    targets.push({
      name: resolved || raw,
      kind: found[1].includes("library") ? "library" : "executable",
      // A name that did not come out as a string is a guess, and the panel
      // says so: it is the one thing a person checks.
      detail: resolved ? found[1] : found[1] + " · guess",
      guessed: !resolved,
    });
  }
  const subdirs: string[] = [];
  const subs = /\bsubdir\s*\(\s*'([^']+)'/g;
  while ((found = subs.exec(clean)) !== null) {
    subdirs.push(found[1]);
  }
  return { title, targets, subdirs };
}

// symbols are the assignments of a file, by name, in order: a name assigned
// twice keeps the last, which is what Meson would read.
function symbols(clean: string): { [name: string]: string } {
  const out: { [name: string]: string } = {};
  const lines = clean.split("\n");
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// value is what a name or a literal stands for: a quoted string, a
// variable, or meson.project_name(), which is the project's own name.
// Nothing else is followed, and an empty answer says the name could not be
// found, which the caller marks as a guess.
function value(raw: string, vars: { [name: string]: string }, hop: number, title?: string): string {
  const text = raw.trim();
  if (!text) return "";
  const quoted = text.match(/^'([^']*)'/);
  if (quoted) return quoted[1];
  // meson.project_name() is the name of the project() call above, which
  // is the one name a file cannot tell without reading the root.
  if (/^meson\.project_name\s*\(\s*\)/.test(text)) return title || "";
  if (/^meson\.project_version\s*\(\s*\)/.test(text)) return "";
  if (hop >= assignHops) return "";
  const name = text.match(/^([A-Za-z_][\w]*)$/);
  if (name) {
    const assigned = vars[name[1]];
    if (assigned === undefined) return "";
    return value(assigned, vars, hop + 1, title);
  }
  // A concatenation of a string and something else, as
  // c_name + '-resources', keeps its first quoted part, which is what the
  // executable is usually called.
  const head = text.match(/^'([^']+)'\s*\+/);
  if (head) return head[1];
  return "";
}

// tasks are what a person would type, with the setup folded into the build
// so that a folder that has never been built builds.
function tasks(rough: Rough, targets: Target[], isDefault: boolean): Task[] {
  const dir = "build";
  const out: Task[] = [];
  out.push({
    label: "build",
    type: "shell",
    command: `if [ -f ${dir}/build.ninja ]; then meson compile -C ${dir}; else meson setup ${dir} && meson compile -C ${dir}; fi`,
    group: { kind: "build", isDefault },
    detail: rough.title ? "meson · " + rough.title : "meson",
    builder: "meson",
    problemMatcher: matcher("compilers"),
  });
  for (const target of targets) {
    out.push({
      label: "build " + target.name,
      type: "process",
      command: "meson",
      args: ["compile", "-C", dir, target.name],
      group: "build",
      detail: target.guessed ? "meson · " + target.detail + " · " + (target.detail || "") : target.detail,
      builder: "meson",
      problemMatcher: matcher("compilers"),
    });
  }
  out.push({
    label: "setup",
    type: "process",
    command: "meson",
    args: ["setup", dir],
    builder: "meson",
  });
  out.push({
    label: "test",
    type: "process",
    command: "meson",
    args: ["test", "-C", dir],
    group: "test",
    builder: "meson",
    problemMatcher: matcher("compilers"),
  });
  out.push({
    label: "clean",
    type: "process",
    command: "meson",
    args: ["setup", "--wipe", dir],
    builder: "meson",
  });
  return out;
}

function stripComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let out = "";
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "'" && line[i - 1] !== "\\") quoted = !quoted;
        if (c === "#" && !quoted) break;
        out += c;
      }
      return out;
    })
    .join("\n");
}

async function read(path: string): Promise<string | null> {
  try {
    return await workspace.readFile(path);
  } catch {
    return null;
  }
}

async function stat(path: string): Promise<boolean> {
  try {
    const info = await workspace.stat(path);
    return !!info && !info.isDir;
  } catch {
    return false;
  }
}

function join(dir: string, sub: string): string {
  if (sub.startsWith("/")) return sub;
  const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return base + "/" + sub.replace(/^\.\//, "");
}

function basename(path: string): string {
  const at = path.lastIndexOf("/");
  return at >= 0 ? path.slice(at + 1) : path;
}
