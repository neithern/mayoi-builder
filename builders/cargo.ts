// Cargo: a crate or a workspace of crates, whose targets cargo itself
// knows best and whose files say enough for a scan.
//
// A workspace root says its members, and a member's own Cargo.toml says
// its binary and library targets. A scan reads the root and each member's
// file, which is a handful of calls on a workspace of a handful of crates.
//
// cargo metadata would be exact, and it is not asked: it costs a process,
// and a scan runs no program. The guess is close enough for the tasks that
// matter, and it works where cargo is not installed at all.

import { workspace } from "mayoi";
import { matcher, type Builder, type Rough, type Target, type Task } from "./types";

// memberLimit is how many members of a workspace a scan reads.
const memberLimit = 12;

const builder: Builder = {
  id: "cargo",
  markers: ["Cargo.toml"],
  guess,
  tasks,
};
export default builder;

async function guess(root: string): Promise<Rough | null> {
  const text = await read(root + "/Cargo.toml");
  if (text === null) return null;
  const targets: Target[] = [];

  // A root that is a package has targets of its own, as [[bin]] name or as
  // src/main.rs, which is a binary nobody named. A root that is only a
  // workspace has none, and its members are the whole of it.
  const hasPackage = /^\[package\]/m.test(text);
  const self = packageTargets(text);
  const name = packageName(text) || basename(root);
  const seen = new Set<string>();
  const push = (target: Target) => {
    const key = target.kind + ":" + target.name;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };
  let rootBins = 0;
  for (const target of self) {
    if (target.kind === "bin" && target.name) rootBins++;
    if (target.name) push(target);
  }
  if (hasPackage && rootBins === 0 && (await existsFile(root + "/src/main.rs"))) {
    push({ name, kind: "bin", detail: "src/main.rs" });
  }

  // A workspace names its members, and each is read for its own targets.
  const members = workspaceMembers(text);
  let readCount = 0;
  for (const member of members) {
    if (readCount >= memberLimit) break;
    const memberDir = join(root, member);
    const memberText = await read(memberDir + "/Cargo.toml");
    if (memberText === null) continue;
    readCount++;
    const memberName = packageName(memberText) || basename(member);
    const own = packageTargets(memberText);
    // A member's binaries are its own to build, and a member with a
    // library and no binary builds under its package name.
    let bins = 0;
    for (const target of own) {
      if (target.kind !== "bin" || !target.name) continue;
      bins++;
      push({ name: target.name, kind: "bin", detail: memberName });
    }
    if (bins === 0 && (await existsFile(memberDir + "/src/main.rs"))) {
      bins++;
      push({ name: memberName, kind: "bin", detail: member });
    }
    if (bins === 0) push({ name: memberName, kind: "member", detail: member });
  }

  return { targets, title: name };
}

// packageTargets are the targets a Cargo.toml declares: its [[bin]] names,
// and its library.
function packageTargets(text: string): Target[] {
  const out: Target[] = [];
  const bins = /\[\[bin\]\][\s\S]*?name\s*=\s*"([^"]+)"/g;
  let found: RegExpExecArray | null;
  while ((found = bins.exec(text)) !== null) {
    out.push({ name: found[1], kind: "bin", detail: "[[bin]]" });
  }
  if (out.length === 0 && /\[lib\]/.test(text)) {
    out.push({ name: "", kind: "library", detail: "[lib]" });
  }
  return out;
}

function packageName(text: string): string {
  // The [package] block's own name, not the [workspace.package] one.
  const block = text.split(/^\[/m);
  for (const part of block) {
    if (!part.startsWith("package]")) continue;
    const name = part.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (name) return name[1];
  }
  return "";
}

// workspaceMembers are the members a [workspace] names, as paths relative
// to the root.
function workspaceMembers(text: string): string[] {
  const at = text.indexOf("[workspace]");
  if (at < 0) return [];
  const block = text.slice(at);
  const members = block.match(/members\s*=\s*\[([\s\S]*?)\]/);
  if (!members) return [];
  const out: string[] = [];
  const quoted = /"([^"]+)"/g;
  let found: RegExpExecArray | null;
  while ((found = quoted.exec(members[1])) !== null) {
    // A pattern of members, as crates/*, names a set that only listing
    // tells, so it is left out with the rest that cannot be followed.
    if (found[1].includes("*")) continue;
    out.push(found[1]);
  }
  return out;
}

// tasks are what a person would type, with the flag that makes a rust
// problem one line: without --message-format=short rustc writes the place
// on a line of its own, which the panel does not join, and the problem
// never reaches it.
function tasks(rough: Rough, targets: Target[], isDefault: boolean): Task[] {
  const out: Task[] = [];
  out.push({
    label: "build",
    type: "process",
    command: "cargo",
    args: ["build", "--message-format=short"],
    group: { kind: "build", isDefault },
    detail: "cargo",
    builder: "cargo",
    problemMatcher: matcher("rust"),
  });
  for (const target of targets) {
    if (target.kind !== "bin" && target.kind !== "member") continue;
    out.push({
      label: "build -p " + target.name,
      type: "process",
      command: "cargo",
      args: ["build", "-p", target.name, "--message-format=short"],
      group: "build",
      detail: target.detail,
      builder: "cargo",
      problemMatcher: matcher("rust"),
    });
  }
  for (const target of targets) {
    if (target.kind !== "bin") continue;
    out.push({
      label: "run " + target.name,
      type: "process",
      command: "cargo",
      args: ["run", "--bin", target.name, "--message-format=short"],
      builder: "cargo",
      problemMatcher: matcher("rust"),
    });
  }
  out.push({
    label: "test",
    type: "process",
    command: "cargo",
    args: ["test", "--message-format=short"],
    group: "test",
    builder: "cargo",
    problemMatcher: matcher("rust"),
  });
  out.push({
    label: "clean",
    type: "process",
    command: "cargo",
    args: ["clean"],
    builder: "cargo",
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

async function existsFile(path: string): Promise<boolean> {
  try {
    const info = await workspace.stat(path);
    return !!info && !info.isDir;
  } catch {
    return false;
  }
}

function join(dir: string, sub: string): string {
  const base = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  if (sub.startsWith("/")) return sub;
  return base + "/" + sub.replace(/^\.\//, "");
}

function basename(path: string): string {
  const at = path.lastIndexOf("/");
  return at >= 0 ? path.slice(at + 1) : path;
}
