// Go: a module whose executables are its main packages, which only the go
// command can say for certain.
//
// A go.mod names a module and nothing else: it does not say which packages
// build a program, and finding one means reading every .go file for
// "package main", which on a folder of a few hundred files is a scan far
// past what its cost allows. So the guess names the module and no targets,
// and the targets come from the go command itself, which answers in one
// call and is already there on any machine that can build the thing.

import { process, workspace } from "mayoi";
import { matcher, type Builder, type Rough, type Target, type Task } from "./types";

const builder: Builder = {
  id: "go",
  markers: ["go.mod"],
  guess,
  ask,
  tasks,
};
export default builder;

// guess reads go.mod: the module's name, and whether it is a workspace.
async function guess(root: string): Promise<Rough | null> {
  const text = await read(root + "/go.mod");
  if (text === null) return null;
  // The module line names the module, which is what a folder of several
  // go.mod files is told apart by. A go.work is a set of modules, whose
  // own names are the ones a person knows.
  const module = text.match(/^module\s+(\S+)/m);
  const notes = [];
  if (await exists(root + "/go.work")) {
    notes.push({ key: "unparsed" as const, subject: "go.work" });
  }
  return { targets: [], title: module ? module[1].split("/").pop() : undefined, notes };
}

// ask lists the main packages, which are the programs a module builds.
async function ask(root: string): Promise<Target[] | null> {
  try {
    const out = await process.run(
      "go",
      // The template asks for the two things a task needs: where the
      // package is, and what it is called. Only main packages build.
      ["list", "-f", '{{if eq .Name "main"}}{{.ImportPath}}|{{.Dir}}{{end}}', "./..."],
      { cwd: root, timeout: 20000 },
    );
    if (out.code !== 0) return null;
    const targets: Target[] = [];
    for (const line of out.stdout.split("\n")) {
      const at = line.indexOf("|");
      if (at < 0) continue;
      const path = line.slice(0, at).trim();
      const dir = line.slice(at + 1).trim();
      if (!path || !dir) continue;
      // A program is named after the last part of its package path, which
      // is the binary go would write.
      const name = path.split("/").pop() || path;
      targets.push({
        name,
        kind: "executable",
        // The package path is what go builds, and the name is what it
        // writes: two programs of one name are told apart by the path.
        path: trim(root, dir) === "." ? "." : "./" + trim(root, dir),
        detail: "go · " + trim(root, dir),
      });
    }
    return targets.length ? targets : null;
  } catch {
    return null;
  }
}

// tasks are what a person would type: the whole module, then one program
// of it, and the commands every module has.
function tasks(rough: Rough, targets: Target[], isDefault: boolean): Task[] {
  const out: Task[] = [];
  out.push({
    label: "build",
    type: "process",
    command: "go",
    // -v names each package as it is built, which is the only thing the
    // go command says while it works: a build that succeeds prints
    // nothing at all without it, and a panel that prints nothing looks
    // like one that is not running.
    args: ["build", "-v", "./..."],
    group: { kind: "build", isDefault },
    detail: "go",
    builder: "go",
    problemMatcher: matcher("go"),
  });
  for (const target of targets) {
    out.push({
      label: "build " + target.name,
      type: "process",
      command: "go",
      // The package path, not the name: go build takes a package, and a
      // folder of two programs of one name builds the wrong one by name.
      // Without -o the program lands in the folder the command runs in,
      // which is what a person typing "go build ./cmd/app" gets, and what
      // a project's .gitignore already knows to leave out.
      args: ["build", "-v", target.path || target.name],
      group: "build",
      detail: target.detail,
      builder: "go",
      problemMatcher: matcher("go"),
    });
  }
  // One run per program, and none when there is none: a module's root is
  // not a program, and "go run ." there fails with "no Go files", which a
  // task that was never right cannot be run to discover.
  for (const target of targets) {
    out.push({
      label: "run " + target.name,
      type: "process",
      command: "go",
      args: ["run", target.path || target.name],
      builder: "go",
      problemMatcher: matcher("go"),
    });
  }
  out.push({
    label: "test",
    type: "process",
    command: "go",
    args: ["test", "./..."],
    group: "test",
    builder: "go",
    problemMatcher: matcher("go"),
  });
  out.push({
    label: "vet",
    type: "process",
    command: "go",
    args: ["vet", "./..."],
    builder: "go",
    problemMatcher: matcher("go"),
  });
  return out;
}

// trim is a folder's path as a person reads it: relative to the root when
// it is under it.
function trim(root: string, path: string): string {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  if (path === base) return ".";
  return path.startsWith(base + "/") ? path.slice(base.length + 1) : path;
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
