// Swift Package Manager: a project whose build is described by
// Package.swift, which is Swift code rather than data.
//
// A product is declared as .executable(name: "CoreEQ", ...), so the names
// come out of the text. It is a program, and could in principle compute
// its own products, which is why swift package describe exists and is
// asked last: it needs the toolchain, and a toolchain that cannot write
// its caches refuses the manifest outright. A scan that needed it would
// show nothing on such a machine, so the text is what a scan reads.

import { workspace } from "mayoi";
import { matcher, type Builder, type Rough, type Target, type Task } from "./types";

const builder: Builder = {
  id: "swift",
  markers: ["Package.swift"],
  guess,
  tasks,
};
export default builder;

async function guess(root: string): Promise<Rough | null> {
  const text = await read(root + "/Package.swift");
  if (text === null) return null;
  const targets: Target[] = [];

  // .executable(name: "CoreEQ", targets: [...]) and .library(name: "X", ...)
  const products = /\.(executable|library)\s*\(\s*name\s*:\s*"([^"]+)"/g;
  let found: RegExpExecArray | null;
  while ((found = products.exec(text)) !== null) {
    targets.push({
      name: found[2],
      kind: found[1] === "executable" ? "product" : "library",
      detail: "." + found[1],
    });
  }

  const name = text.match(/\bPackage\s*\(\s*[^)]*?name\s*:\s*"([^"]+)"/);
  return { targets, title: name ? name[1] : basename(root) };
}

function tasks(rough: Rough, targets: Target[], isDefault: boolean): Task[] {
  const out: Task[] = [];
  out.push({
    label: "build",
    type: "process",
    command: "swift",
    args: ["build"],
    group: { kind: "build", isDefault },
    detail: "swift",
    builder: "swift",
    problemMatcher: matcher("compilers"),
  });
  for (const target of targets) {
    if (target.kind !== "product") continue;
    out.push({
      label: "build " + target.name,
      type: "process",
      command: "swift",
      args: ["build", "--product", target.name],
      group: "build",
      detail: target.detail,
      builder: "swift",
      problemMatcher: matcher("compilers"),
    });
  }
  for (const target of targets) {
    if (target.kind !== "product") continue;
    out.push({
      label: "run " + target.name,
      type: "process",
      command: "swift",
      args: ["run", target.name],
      builder: "swift",
      problemMatcher: matcher("compilers"),
    });
  }
  out.push({
    label: "test",
    type: "process",
    command: "swift",
    args: ["test"],
    group: "test",
    builder: "swift",
    problemMatcher: matcher("compilers"),
  });
  out.push({
    label: "clean",
    type: "process",
    command: "swift",
    args: ["package", "clean"],
    builder: "swift",
  });
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
  const at = path.lastIndexOf("/");
  return at >= 0 ? path.slice(at + 1) : path;
}
