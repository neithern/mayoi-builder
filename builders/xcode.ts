// Xcode: a project whose build is described by a .xcodeproj bundle, which
// holds a pbxproj file of schemes and targets in Xcode's own format.
//
// Nothing of a pbxproj is readable by a guess worth having, so this build
// system has no guess at all: it is found by stat, its targets come from
// xcodebuild, and until a person inspects the project the panel shows a
// task that runs xcodebuild and nothing else.
//
// It is also the build system a Makefile most often wraps: a folder with
// both builds through the Makefile, and this one adds the scheme and
// configuration the Makefile chose for it.

import { process, workspace } from "mayoi";
import { matcher, type Builder, type Rough, type Target, type Task } from "./types";

const builder: Builder = {
  id: "xcode",
  markers: [],
  guess,
  ask,
  tasks,
};
export default builder;

// guess finds the project bundle at the root, by listing it: the one call
// in this plugin that lists, and one that runs only when a person asks for
// an inspection or a scan that says so.
async function guess(root: string): Promise<Rough | null> {
  const projects = await workspace.findFiles("*.xcodeproj", { limit: 20 });
  const atRoot = projects.filter((p) => (p.match(/\//g) || []).length === 1).map((p) => p.split("/")[0]);
  const workspaces = (await workspace.findFiles("*.xcworkspace", { limit: 20 }))
    .filter((p) => (p.match(/\//g) || []).length === 1)
    .map((p) => p.split("/")[0]);
  const names = Array.from(new Set([...atRoot, ...workspaces]));
  if (!names.length) return null;
  return {
    targets: names.map((name) => ({ name, kind: "member", detail: name })),
    title: names[0].replace(/\.(xcodeproj|xcworkspace)$/, ""),
  };
}

// ask reads the schemes and targets xcodebuild knows.
async function ask(root: string, rough: Rough): Promise<Target[] | null> {
  const bundle = (rough.targets[0] || {}).name;
  if (!bundle) return null;
  if (bundle.endsWith(".xcworkspace")) return null;
  try {
    const out = await process.run(
      "xcodebuild",
      ["-list", "-json", "-project", bundle],
      { cwd: root, timeout: 20000 },
    );
    if (out.code !== 0) return null;
    const parsed = JSON.parse(out.stdout);
    const project = parsed && parsed.project;
    if (!project) return null;
    const schemes: string[] = project.schemes || [];
    const configurations: string[] = project.configurations || [];
    const targets: Target[] = schemes.map((name) => ({ name, kind: "executable", detail: "scheme" }));
    if (!targets.length) {
      for (const name of project.targets || []) targets.push({ name, kind: "executable", detail: "target" });
    }
    if (configurations.length && !/^Debug|Release$/.test(configurations[0])) {
      // Nothing to add: the configurations become the arguments of the
      // build below, and the first is the one a build would use.
    }
    return targets;
  } catch {
    return null;
  }
}

function tasks(rough: Rough, targets: Target[], isDefault: boolean): Task[] {
  const bundle = (rough.targets[0] || {}).name || "";
  if (!bundle) return [];
  const out: Task[] = [];
  const scheme = targets.length ? targets[0].name : rough.title || "";
  out.push({
    label: "build",
    type: "process",
    command: "xcodebuild",
    args: ["-project", bundle, "-scheme", scheme, "-configuration", "Debug", "build"],
    group: { kind: "build", isDefault: false },
    detail: "xcodebuild",
    builder: "xcode",
    problemMatcher: matcher("compilers"),
  });
  return out;
}
