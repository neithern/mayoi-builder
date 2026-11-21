// CMake: a project whose build is described by CMakeLists.txt, and whose
// targets CMake itself knows best.
//
// The guess is the one that has to work, and on a CMake project it takes
// real parsing: a target is declared as add_executable(name ...), but the
// file that declares it may be three add_subdirectory calls down, and the
// name may be a variable. The File API is exact and much better, and it
// needs a configured build directory, which a scan may not make.
//
// So a scan reads the files, and a build configures: the first build of a
// folder makes the build directory it needs, which is what a person
// running cmake by hand would do too.

import { workspace } from "mayoi";
import { matcher, type Builder, type Note, type Rough, type Target, type Task } from "./types";

// subdirLimit is how many build files the walk reads beyond the root's:
// enough for the shape a CMake project usually has, and few enough that a
// scan of a folder far away stays a few calls.
const subdirLimit = 6;
// subdirDepth is how deep add_subdirectory is followed.
const subdirDepth = 2;

const builder: Builder = {
  id: "cmake",
  markers: ["CMakeLists.txt"],
  guess,
  tasks,
};
export default builder;

// guess reads CMakeLists.txt, and those of the folders it adds.
async function guess(root: string): Promise<Rough | null> {
  const first = await read(root + "/CMakeLists.txt");
  if (first === null) return null;
  const notes: Note[] = [];
  const targets: Target[] = [];
  let title: string | undefined;
  const seen = new Set<string>();
  let budget = subdirLimit;

  const walk = async (dir: string, depth: number) => {
    const path = dir + "/CMakeLists.txt";
    const text = dir === root ? first : await read(path);
    if (text === null) return;
    const parsed = parse(text);
    title = title || parsed.title;
    for (const target of parsed.targets) {
      if (seen.has(target.name)) continue;
      seen.add(target.name);
      targets.push(target);
    }
    for (const note of parsed.notes) notes.push(note);
    if (depth >= subdirDepth) return;
    for (const sub of parsed.subdirs) {
      // A folder CMake adds but that is not there is the shape of an
      // uninitialised submodule, and worth saying before a build finds it.
      const info = await stat(dir + "/" + sub + "/CMakeLists.txt");
      if (!info) {
        notes.push({ key: "initialised", subject: sub });
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

  // A CMakeLists.txt that asks for a version this cmake no longer takes is
  // the one failure CMake makes before reading anything else, and it says
  // so in terms of a policy a person has to look up. Saying it here is the
  // difference between a build that fails in a wall of text and one that
  // fails before it starts.
  const minimum = first.match(/cmake_minimum_required\s*\(\s*VERSION\s+([\d.]+)/i);
  if (minimum) {
    const major = parseInt(minimum[1].split(".")[0], 10) || 0;
    const minor = parseInt(minimum[1].split(".")[1] || "0", 10) || 0;
    if (major < 3 || (major === 3 && minor < 5)) {
      notes.push({ key: "oldPolicy", subject: minimum[1] });
    }
  }

  return { targets, title: title || basename(root), notes };
}

// parse reads one CMakeLists.txt: its project, its targets, the folders it
// adds, and what it says about itself.
function parse(text: string): { title?: string; targets: Target[]; subdirs: string[]; notes: Note[] } {
  const clean = stripComments(text);
  const targets: Target[] = [];
  const subdirs: string[] = [];
  let title: string | undefined;
  const project = clean.match(/\bproject\s*\(\s*([A-Za-z0-9_.-]+)/i);
  if (project) title = project[1];
  // add_executable(name ...) and add_library(name ...), which may put the
  // name on the line after the call.
  const declared = /\badd_(executable|library|custom_target)\s*\(\s*([A-Za-z_][\w.-]*)/gi;
  let found: RegExpExecArray | null;
  while ((found = declared.exec(clean)) !== null) {
    targets.push({
      name: found[2],
      kind: found[1].toLowerCase() === "executable" ? "executable" : found[1].toLowerCase() === "library" ? "library" : "recipe",
      detail: "add_" + found[1],
    });
  }
  const added = /\badd_subdirectory\s*\(\s*([A-Za-z0-9_.\/-]+)/gi;
  while ((found = added.exec(clean)) !== null) {
    subdirs.push(found[1]);
  }
  return { title, targets, subdirs, notes: [] };
}

// tasks are what a person would type: configure once, build, test, and
// the two that a build system's own commands cover.
function tasks(rough: Rough, targets: Target[], isDefault: boolean): Task[] {
  const out: Task[] = [];
  const dir = "build";
  // A CMakeLists.txt that asks for a version this cmake takes no longer
  // fails at its first line, and the way past it is a policy variable a
  // person has to know. Adding it where the version is old is the
  // difference between a build that works and one that fails in text the
  // panel does not even read.
  const oldPolicy = (rough.notes || []).some((n) => n.key === "oldPolicy");
  const policy = oldPolicy ? "-DCMAKE_POLICY_VERSION_MINIMUM=3.5 " : "";
  const detail = oldPolicy ? "cmake · policy 3.5" : "cmake";
  const configure = `cmake ${policy}-S . -B ${dir}`;
  // The build does what a person would do on a folder that has never been
  // built, and only that once: a build directory that is there is used as
  // it is, so a second build is a build and not a configure.
  out.push({
    label: "build",
    type: "shell",
    command: `if [ -f ${dir}/CMakeCache.txt ] && { [ -f ${dir}/build.ninja ] || [ -f ${dir}/Makefile ]; }; then cmake --build ${dir}; else ${configure} && cmake --build ${dir}; fi`,
    group: { kind: "build", isDefault },
    detail,
    builder: "cmake",
    problemMatcher: matcher("compilers"),
  });
  out.push({
    label: "configure",
    type: "shell",
    command: `${configure} || true`,
    detail,
    builder: "cmake",
  });
  for (const target of targets) {
    // A recipe has nothing to build on its own: it is a name of a rule, and
    // the build already runs what it names.
    if (target.kind === "recipe") continue;
    out.push({
      label: "build " + target.name,
      type: "shell",
      // A target build of a folder that has never been configured would
      // fail on a build directory that is not there: this configures as
      // the full build does, then builds the one target.
      command: `if [ -f ${dir}/CMakeCache.txt ] && { [ -f ${dir}/build.ninja ] || [ -f ${dir}/Makefile ]; }; then cmake --build ${dir} --target ${target.name}; else ${configure} && cmake --build ${dir} --target ${target.name}; fi`,
      group: "build",
      detail: target.detail,
      builder: "cmake",
      problemMatcher: matcher("compilers"),
    });
  }
  out.push({
    label: "test",
    type: "process",
    command: "ctest",
    args: ["--test-dir", dir, "--output-on-failure"],
    group: "test",
    builder: "cmake",
    problemMatcher: matcher("compilers"),
  });
  out.push({
    label: "clean",
    type: "process",
    command: "cmake",
    args: ["--build", dir, "--target", "clean"],
    builder: "cmake",
  });
  out.push({
    label: "install",
    type: "process",
    command: "cmake",
    args: ["--install", dir],
    builder: "cmake",
  });
  return out;
}

// stripComments takes out what CMake reads as a comment, keeping the line
// count, so that a # inside a string stays.
function stripComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let out = "";
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') quoted = !quoted;
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
