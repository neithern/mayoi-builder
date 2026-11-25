// Xcode: a project whose build is described by a .xcodeproj or .xcworkspace
// bundle named after the folder, holding project.pbxproj or workspace data.
//
// A scan never lists the folder, so Xcode is found by statting the bundle
// that shares the folder's name (<folder>.xcworkspace/contents.xcworkspacedata
// or <folder>.xcodeproj/project.pbxproj): at most two stat calls, whatever
// the project holds.
//
// Schemes come from xcodebuild -list -json through ask, and when xcodebuild
// is missing or fails the folder's own name stands in as the scheme so the
// tasks still list.

import { process, workspace } from "mayoi";
import { matcher, type Builder, type Rough, type Target, type Task } from "./types";

const builder: Builder = {
  id: "xcode",
  markers: [],
  present,
  guess,
  ask,
  tasks,
};
export default builder;

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  return at >= 0 ? trimmed.slice(at + 1) : trimmed;
}

async function existsFile(path: string): Promise<boolean> {
  try {
    const info = await workspace.stat(path);
    return !!info && !info.isDir;
  } catch {
    return false;
  }
}

// findBundle checks for a workspace or project bundle sharing the folder's
// name at the root, or one level down in a same-name subfolder (as
// QuickMD/QuickMD.xcodeproj in a repo named quickmd): at most four stat
// calls and no directory listing. A workspace takes precedence when both
// exist, as with CocoaPods projects.
async function findBundle(root: string): Promise<string | null> {
  const name = basename(root);
  if (!name) return null;
  const candidates: [string, string][] = [
    [name + ".xcworkspace", "contents.xcworkspacedata"],
    [name + ".xcodeproj", "project.pbxproj"],
    [name + "/" + name + ".xcworkspace", "contents.xcworkspacedata"],
    [name + "/" + name + ".xcodeproj", "project.pbxproj"],
  ];
  for (const [bundle, marker] of candidates) {
    if (await existsFile(root + "/" + bundle + "/" + marker)) {
      return bundle;
    }
  }
  return null;
}

async function present(root: string): Promise<boolean> {
  return (await findBundle(root)) !== null;
}

// guess records the same-name bundle and leaves targets empty so scan()
// asks xcodebuild for the declared schemes.
async function guess(root: string): Promise<Rough | null> {
  const bundle = await findBundle(root);
  if (!bundle) return null;
  const title = basename(bundle).replace(/\.(xcodeproj|xcworkspace)$/, "");
  return {
    targets: [],
    title,
    bundle,
  };
}

// ask reads the schemes (or targets when no scheme is shared) xcodebuild knows.
async function ask(root: string, rough: Rough): Promise<Target[] | null> {
  const bundle = rough.bundle;
  if (!bundle) return null;
  const isWorkspace = bundle.endsWith(".xcworkspace");
  const flag = isWorkspace ? "-workspace" : "-project";
  try {
    const out = await process.run(
      "xcodebuild",
      ["-list", "-json", flag, bundle],
      { cwd: root, timeout: 20000 },
    );
    if (out.code !== 0) return null;
    const parsed = JSON.parse(out.stdout);
    const info = isWorkspace ? parsed && parsed.workspace : parsed && parsed.project;
    if (!info) return null;
    // Adopt the canonical casing reported by xcodebuild (e.g. "QuickMD" when
    // the repo folder is lowercase "quickmd" on a case-insensitive volume).
    if (typeof info.name === "string" && info.name) {
      rough.title = info.name;
      const ext = isWorkspace ? ".xcworkspace" : ".xcodeproj";
      const marker = isWorkspace ? "contents.xcworkspacedata" : "project.pbxproj";
      const slash = bundle.indexOf("/");
      if (slash >= 0) {
        const dir = bundle.slice(0, slash);
        const dirFixed = dir.toLowerCase() === info.name.toLowerCase() ? info.name : dir;
        const candidate = dirFixed + "/" + info.name + ext;
        if (await existsFile(root + "/" + candidate + "/" + marker)) {
          rough.bundle = candidate;
        }
      } else {
        const candidate = info.name + ext;
        if (await existsFile(root + "/" + candidate + "/" + marker)) {
          rough.bundle = candidate;
        }
      }
    }
    const schemes: string[] = Array.isArray(info.schemes) ? info.schemes : [];
    const targets: Target[] = schemes.map((name) => ({ name, kind: "executable", detail: "scheme" }));
    if (!targets.length && !isWorkspace && Array.isArray(info.targets)) {
      for (const name of info.targets) {
        targets.push({ name, kind: "executable", detail: "target" });
      }
    }
    // Put the scheme or target named after the project first so it becomes
    // the default build when several exist.
    if (rough.title && targets.length > 1) {
      const want = rough.title.toLowerCase();
      const idx = targets.findIndex((t) => t.name.toLowerCase() === want);
      if (idx > 0) targets.unshift(targets.splice(idx, 1)[0]);
    }
    return targets.length ? targets : null;
  } catch {
    return null;
  }
}

function tasks(rough: Rough, targets: Target[], isDefault: boolean): Task[] {
  const bundle = rough.bundle || "";
  if (!bundle) return [];
  const isWorkspace = bundle.endsWith(".xcworkspace");
  const flag = isWorkspace ? "-workspace" : "-project";
  const primary = targets[0];
  const byTarget = primary?.detail === "target";
  const selector = byTarget ? "-target" : "-scheme";
  const mainName = primary ? primary.name : (rough.title || basename(bundle).replace(/\.(xcodeproj|xcworkspace)$/, ""));
  const out: Task[] = [];

  // CODE_SIGNING_ALLOWED=NO skips provisioning and team certificates: most
  // cloned Xcode projects carry their author's DEVELOPMENT_TEAM in pbxproj,
  // which fails on any other machine without that signing identity.
  out.push({
    label: "build",
    type: "process",
    command: "xcodebuild",
    args: [flag, bundle, selector, mainName, "-configuration", "Debug", "CODE_SIGNING_ALLOWED=NO", "build"],
    group: { kind: "build", isDefault },
    detail: "xcodebuild",
    builder: "xcode",
    problemMatcher: matcher("compilers"),
  });

  out.push({
    label: "build release",
    type: "process",
    command: "xcodebuild",
    args: [flag, bundle, selector, mainName, "-configuration", "Release", "CODE_SIGNING_ALLOWED=NO", "build"],
    group: "build",
    detail: "xcodebuild",
    builder: "xcode",
    problemMatcher: matcher("compilers"),
  });

  // Additional schemes or targets beyond the primary one.
  for (const target of targets.slice(1)) {
    if (target.name === mainName) continue;
    const targetFlag = target.detail === "target" ? "-target" : "-scheme";
    out.push({
      label: "build " + target.name,
      type: "process",
      command: "xcodebuild",
      args: [flag, bundle, targetFlag, target.name, "-configuration", "Debug", "CODE_SIGNING_ALLOWED=NO", "build"],
      group: "build",
      detail: target.detail,
      builder: "xcode",
      problemMatcher: matcher("compilers"),
    });
  }

  // xcodebuild test requires -scheme.
  if (!byTarget) {
    out.push({
      label: "test",
      type: "process",
      command: "xcodebuild",
      args: [flag, bundle, "-scheme", mainName, "-configuration", "Debug", "CODE_SIGNING_ALLOWED=NO", "test"],
      group: "test",
      detail: "xcodebuild",
      builder: "xcode",
      problemMatcher: matcher("compilers"),
    });
  }

  out.push({
    label: "clean",
    type: "process",
    command: "xcodebuild",
    args: [flag, bundle, selector, mainName, "-configuration", "Debug", "clean"],
    detail: "xcodebuild",
    builder: "xcode",
  });

  return out;
}
