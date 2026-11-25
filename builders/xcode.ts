// Xcode: a project whose build is described by a .xcodeproj or .xcworkspace
// bundle named after the folder, holding project.pbxproj or workspace data.
//
// A scan never lists the folder, so Xcode is found by statting the bundle
// that shares the folder's name (<folder>.xcworkspace/contents.xcworkspacedata
// or <folder>.xcodeproj/project.pbxproj, at root or in a same-name subfolder):
// at most four stat calls, whatever the project holds.
//
// Schemes come from xcodebuild -list -json through ask, and when xcodebuild
// is missing or fails the folder's own name stands in as the scheme so the
// tasks still list.

import { process, workspace } from "mayoi";
import { matcher, type Builder, type Matcher, type Rough, type Target, type Task } from "./types";

interface XcodeConfig {
  xcode?: {
    signing?: boolean;
    destination?: string;
  };
}

// xcodeProjectError matches project-level errors that have no line number,
// such as signing or provisioning failures:
//   /path/QuickMD.xcodeproj: error: No signing certificate ...
const xcodeProjectError: Matcher = {
  regexp: "^(.+?\\.(?:xcodeproj|xcworkspace)): (error|warning): (.+)$",
  file: 1,
  severity: 2,
  message: 3,
};

const xcodeMatchers: Matcher[] = [matcher("compilers"), xcodeProjectError];

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

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-.,:/=@%+]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function existsFile(path: string): Promise<boolean> {
  try {
    const info = await workspace.stat(path);
    return !!info && !info.isDir;
  } catch {
    return false;
  }
}

async function read(path: string): Promise<string | null> {
  try {
    return await workspace.readFile(path);
  } catch {
    return null;
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

// guess records the same-name bundle and reads SDKROOT from project.pbxproj
// (when it is a .xcodeproj) so iOS projects can pick a simulator destination
// while macOS projects pay zero extra xcodebuild calls.
async function guess(root: string): Promise<Rough | null> {
  const bundle = await findBundle(root);
  if (!bundle) return null;
  const title = basename(bundle).replace(/\.(xcodeproj|xcworkspace)$/, "");
  let platform: "macos" | "ios" | undefined;
  if (bundle.endsWith(".xcodeproj")) {
    const pbx = await read(root + "/" + bundle + "/project.pbxproj");
    if (pbx) {
      const hasMac = /\bSDKROOT\s*=\s*"?macosx\b/.test(pbx);
      const hasIOS = /\bSDKROOT\s*=\s*"?iphoneos\b/.test(pbx);
      if (hasIOS && !hasMac) platform = "ios";
      else if (hasMac) platform = "macos";
    }
  }
  return {
    targets: [],
    title,
    bundle,
    platform,
  };
}

// pickSimulator reads the first available iOS Simulator destination from
// xcodebuild -showdestinations so an iOS project builds without a device.
async function pickSimulator(root: string, flag: string, bundle: string, scheme: string): Promise<string | undefined> {
  try {
    const out = await process.run(
      "xcodebuild",
      [flag, bundle, "-scheme", scheme, "-showdestinations"],
      { cwd: root, timeout: 15000 },
    );
    if (out.code !== 0) return undefined;
    for (const line of out.stdout.split("\n")) {
      if (!line.includes("platform:iOS Simulator")) continue;
      if (line.includes("placeholder") || line.includes("Any iOS Simulator")) continue;
      const id = line.match(/\bid:([^,}]+)/);
      if (id && id[1].trim()) return "platform=iOS Simulator,id=" + id[1].trim();
      const name = line.match(/\bname:([^,}]+)/);
      if (name && name[1].trim()) return "platform=iOS Simulator,name=" + name[1].trim();
    }
  } catch {
    // ignore: fallback to generic simulator destination below
  }
  return "generic/platform=iOS Simulator";
}

// ask reads the schemes (or targets when no scheme is shared) xcodebuild knows.
async function ask(root: string, rough: Rough, config?: unknown): Promise<Target[] | null> {
  const bundle = rough.bundle;
  if (!bundle) return null;
  const cfg = (config as XcodeConfig | undefined)?.xcode;
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
    if (cfg && cfg.destination) {
      rough.destination = cfg.destination;
    } else if (rough.platform === "ios" && targets.length && targets[0].detail === "scheme") {
      rough.destination = await pickSimulator(root, flag, rough.bundle || bundle, targets[0].name);
    }
    return targets.length ? targets : null;
  } catch {
    return null;
  }
}

function tasks(rough: Rough, targets: Target[], isDefault: boolean, config?: unknown): Task[] {
  const bundle = rough.bundle || "";
  if (!bundle) return [];
  const cfg = (config as XcodeConfig | undefined)?.xcode;
  const isWorkspace = bundle.endsWith(".xcworkspace");
  const flag = isWorkspace ? "-workspace" : "-project";
  const primary = targets[0];
  const byTarget = primary?.detail === "target";
  const selector = byTarget ? "-target" : "-scheme";
  const mainName = primary ? primary.name : (rough.title || basename(bundle).replace(/\.(xcodeproj|xcworkspace)$/, ""));
  const dest = (cfg && cfg.destination) || rough.destination;
  const destArgs = dest ? ["-destination", dest] : [];
  // CODE_SIGNING_ALLOWED=NO skips provisioning and team certificates unless
  // opted in via .mayoi/builders.json ("xcode": { "signing": true }): most
  // cloned Xcode projects carry their author's DEVELOPMENT_TEAM in pbxproj.
  const signArgs = cfg && cfg.signing ? [] : ["CODE_SIGNING_ALLOWED=NO"];
  const out: Task[] = [];

  out.push({
    label: "build",
    type: "process",
    command: "xcodebuild",
    args: [flag, bundle, selector, mainName, "-configuration", "Debug", ...destArgs, ...signArgs, "build"],
    group: { kind: "build", isDefault },
    detail: "xcodebuild",
    builder: "xcode",
    problemMatcher: xcodeMatchers,
  });

  out.push({
    label: "build release",
    type: "process",
    command: "xcodebuild",
    args: [flag, bundle, selector, mainName, "-configuration", "Release", ...destArgs, ...signArgs, "build"],
    group: "build",
    detail: "xcodebuild",
    builder: "xcode",
    problemMatcher: xcodeMatchers,
  });

  // Additional schemes or targets beyond the primary one.
  for (const target of targets.slice(1)) {
    if (target.name === mainName) continue;
    const targetFlag = target.detail === "target" ? "-target" : "-scheme";
    out.push({
      label: "build " + target.name,
      type: "process",
      command: "xcodebuild",
      args: [flag, bundle, targetFlag, target.name, "-configuration", "Debug", ...destArgs, ...signArgs, "build"],
      group: "build",
      detail: target.detail,
      builder: "xcode",
      problemMatcher: xcodeMatchers,
    });
  }

  // Run the built macOS app after building Debug.
  if (rough.platform !== "ios" && !byTarget) {
    const buildCmd = ["xcodebuild", flag, bundle, "-scheme", mainName, "-configuration", "Debug", ...destArgs, ...signArgs, "build"]
      .map(shellQuote)
      .join(" ");
    const settingsCmd = ["xcodebuild", flag, bundle, "-scheme", mainName, "-configuration", "Debug", ...destArgs, "-showBuildSettings"]
      .map(shellQuote)
      .join(" ");
    out.push({
      label: "run",
      type: "shell",
      command: buildCmd + ' && open "$(' + settingsCmd + " | awk -F' = ' '/TARGET_BUILD_DIR/{d=$2} /FULL_PRODUCT_NAME/{p=$2} END{print d\"/\"p}')\"",
      detail: "xcodebuild + open",
      builder: "xcode",
      problemMatcher: xcodeMatchers,
    });
  }

  // xcodebuild test requires -scheme.
  if (!byTarget) {
    out.push({
      label: "test",
      type: "process",
      command: "xcodebuild",
      args: [flag, bundle, "-scheme", mainName, "-configuration", "Debug", ...destArgs, ...signArgs, "test"],
      group: "test",
      detail: "xcodebuild",
      builder: "xcode",
      problemMatcher: xcodeMatchers,
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
