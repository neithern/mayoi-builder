// Gradle: a project whose build is described by build.gradle, whose
// modules settings.gradle names, and whose build the wrapper runs.
//
// What a scan can say for certain is the modules and whether the project
// is an Android one: a build file is a program, and the tasks it makes
// depend on plugins resolved while it runs. So the guess names the
// modules, and the tasks are the ones every module of the kind has.
//
// The wrapper is what runs, and never a gradle a machine happens to have:
// a project's gradlew pins the version it was built with, and a build run
// by another version builds another thing.

import { workspace } from "mayoi";
import { matcher, type Builder, type Note, type Rough, type Target, type Task } from "./types";

const builder: Builder = {
  id: "gradle",
  markers: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
  guess,
  tasks,
};
export default builder;

async function guess(root: string): Promise<Rough | null> {
  const settings =
    (await read(root + "/settings.gradle")) ||
    (await read(root + "/settings.gradle.kts"));
  if (settings === null) return null;

  // include ':app', ':library' names the modules, and each is built by
  // the wrapper with ":module:task".
  const targets: Target[] = [];
  const includes = /^\s*include\s+(.+)$/gm;
  let found: RegExpExecArray | null;
  while ((found = includes.exec(settings)) !== null) {
    const quoted = /['"]([^'"]+)['"]/g;
    let one: RegExpExecArray | null;
    while ((one = quoted.exec(found[1])) !== null) {
      const name = one[1].replace(/^:/, "");
      if (name && !targets.some((t) => t.name === name)) {
        targets.push({ name, kind: "member", detail: "module" });
      }
    }
  }

  // A settings file that names no module is a project of one, whose
  // tasks are the root project's.
  const named = settings.match(/^\s*rootProject\.name\s*=\s*['"]([^'"]+)['"]/m);

  const kind = await detectKind(root);
  const android = kind === "android";
  const notes: Note[] = [];
  // An Android project builds only with an SDK, which is named in the
  // project's local.properties or in the environment. Neither is something
  // a scan may assume, and a build that fails for it fails with a wall of
  // Gradle's own words: saying it first is the same fact, sooner.
  if (android && !(await hasSdk(root))) {
    notes.push({ key: "missingSdk", subject: "Android SDK" });
  }
  return {
    targets,
    title: named ? named[1] : undefined,
    // The project flavor rides on tool for tasks() to read: "android",
    // "spring" (bootRun), or "app" (application plugin's run).
    tool: kind || undefined,
    notes,
  };
}

// hasSdk says whether the project names an Android SDK, by the file the
// Android plugin reads or the variable it falls back to.
async function hasSdk(root: string): Promise<boolean> {
  const local = await read(root + "/local.properties");
  if (local && /^\s*sdk\.dir\s*=\s*\S+/m.test(local)) return true;
  return false;
}

// detectKind reads build.gradle(.kts) to tell whether this is an Android
// project, a Spring Boot service, or a JVM application with a run task.
async function detectKind(root: string): Promise<"android" | "spring" | "app" | ""> {
  let found: "spring" | "app" | "" = "";
  for (const name of ["build.gradle", "build.gradle.kts", "app/build.gradle", "app/build.gradle.kts"]) {
    const text = await read(root + "/" + name);
    if (!text) continue;
    if (/com\.android\.(application|library)|android-application|android-library/.test(text)) return "android";
    if (!found && /org\.springframework\.boot/.test(text)) found = "spring";
    else if (!found && (/\bid\s*\(?\s*['"]application['"]\s*\)?/.test(text) || /\bapply\s+plugin\s*:\s*['"]application['"]/.test(text) || /^\s*application\s*\{/m.test(text))) {
      found = "app";
    }
  }
  return found;
}

// tasks are what a person would type: the wrapper, the build type's task,
// and the module's name when the task belongs to one.
function tasks(rough: Rough, targets: Target[], isDefault: boolean): Task[] {
  const android = rough.tool === "android";
  // An Android project builds its debug variant, and "build" is not that:
  // it assembles every variant, and the release one fails on a project
  // that has no signing key set up, which is most of them. So the task a
  // person asks for is the debug one, and the whole build is offered
  // beside it for a project that can sign.
  const buildTask = android ? "assembleDebug" : "build";
  const out: Task[] = [];
  out.push({
    label: "build",
    type: "process",
    command: "./gradlew",
    args: [buildTask],
    group: { kind: "build", isDefault },
    detail: android ? "gradlew · debug" : "gradlew",
    builder: "gradle",
    problemMatcher: matcher("compilers"),
  });
  if (android) {
    // Every variant, which needs a signing key for the release one: a
    // task of its own, and not the default, since it fails where most
    // projects stand.
    out.push({
      label: "build all",
      type: "process",
      command: "./gradlew",
      args: ["build"],
      group: "build",
      detail: "gradlew · release needs a key",
      builder: "gradle",
      problemMatcher: matcher("compilers"),
    });
  }
  for (const target of targets) {
    out.push({
      label: "build " + target.name,
      type: "process",
      command: "./gradlew",
      args: [":" + target.name + ":" + buildTask],
      group: "build",
      detail: target.detail,
      builder: "gradle",
      problemMatcher: matcher("compilers"),
    });
  }
  if (rough.tool === "spring" || rough.tool === "app") {
    const runTask = rough.tool === "spring" ? "bootRun" : "run";
    out.push({
      label: "run",
      type: "process",
      command: "./gradlew",
      args: [runTask],
      detail: "gradlew · " + runTask,
      builder: "gradle",
      problemMatcher: matcher("compilers"),
    });
  }
  out.push({
    label: "test",
    type: "process",
    command: "./gradlew",
    args: ["test"],
    group: "test",
    builder: "gradle",
    problemMatcher: matcher("compilers"),
  });
  out.push({
    label: "clean",
    type: "process",
    command: "./gradlew",
    args: ["clean"],
    builder: "gradle",
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
