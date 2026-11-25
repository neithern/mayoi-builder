// Just: a project whose recipes are declared in a justfile.
//
// Like Make, a justfile's recipes are read directly from the text without
// spawning a process, skipping private recipes (leading _ or [private]) and
// recipes with required parameters that cannot run with zero arguments.

import { process, workspace } from "mayoi";
import { matcher, type Builder, type Rough, type Target, type Task } from "./types";

const justMarkers = ["justfile", "Justfile", ".justfile"];

const builder: Builder = {
  id: "just",
  markers: justMarkers,
  guess,
  ask,
  tasks,
};
export default builder;

async function guess(root: string): Promise<Rough | null> {
  let text: string | null = null;
  let file = "";
  for (const name of justMarkers) {
    text = await read(root + "/" + name);
    if (text !== null) { file = name; break; }
  }
  if (text === null) return null;

  const targets: Target[] = [];
  const seen = new Set<string>();
  const bodies: string[] = [];
  const lines = text.split("\n");
  let isPrivate = false;
  let inRecipe = false;

  for (const raw of lines) {
    // Indented lines belong to the current recipe body.
    if (/^[ \t]+/.test(raw)) {
      if (inRecipe) {
        const body = raw.trim().replace(/^[@-]+/, "");
        if (body && !body.startsWith("#")) bodies.push(body);
      }
      continue;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    inRecipe = false;
    // Attribute line such as [private] or [no-cd].
    if (line.startsWith("[") && line.endsWith("]")) {
      if (/\bprivate\b/.test(line)) isPrivate = true;
      continue;
    }
    // Skip assignments (name := value), set/alias/export/import/mod statements.
    if (/^(?:set|alias|export|import|mod)\b/.test(line) || /^[A-Za-z_][\w-]*\s*:=/.test(line)) {
      isPrivate = false;
      continue;
    }
    const m = raw.match(/^@?([A-Za-z_][\w-]*)((?:\s+[^:#\n]+)*)\s*:(?!=)/);
    if (!m) {
      isPrivate = false;
      continue;
    }
    const name = m[1];
    const params = (m[2] || "").trim();
    const skip = isPrivate || name.startsWith("_") || hasRequiredParams(params);
    isPrivate = false;
    inRecipe = true;
    if (skip || seen.has(name)) continue;
    seen.add(name);
    targets.push({ name, kind: "recipe", detail: file });
  }

  const wraps = wrapped(bodies);
  return { targets, wraps: wraps || undefined };
}

// hasRequiredParams reports whether a recipe's parameter list contains any
// parameter without a default value (=...) and not variadic-optional (*...).
function hasRequiredParams(params: string): boolean {
  if (!params) return false;
  // Strip quoted default values so spaces inside quotes do not split tokens.
  const stripped = params.replace(/=(?:"[^"]*"|'[^']*'|`[^`]*`|\([^)]*\)|[^\s]+)/g, "=DEFAULT");
  for (const tok of stripped.split(/\s+/)) {
    if (!tok) continue;
    if (tok.startsWith("*")) continue; // zero-or-more variadic
    if (tok.includes("=")) continue; // has default
    return true;
  }
  return false;
}

function wrapped(bodies: string[]): string {
  const calls: [string, string][] = [
    ["cargo build", "cargo"],
    ["cargo test", "cargo"],
    ["go build", "go"],
    ["go test", "go"],
    ["swift build", "swift"],
    ["swift test", "swift"],
    ["xcodebuild", "xcode"],
    ["cmake", "cmake"],
    ["meson", "meson"],
    ["zig build", "zig"],
  ];
  for (const [call, id] of calls) {
    if (bodies.some((b) => b.includes(call))) return id;
  }
  return "";
}

// ask reads the exact recipe list from `just --dump --dump-format json` when
// invoked via Inspect.
async function ask(root: string): Promise<Target[] | null> {
  try {
    const out = await process.run("just", ["--dump", "--dump-format", "json"], { cwd: root, timeout: 15000 });
    if (out.code !== 0) return null;
    const parsed = JSON.parse(out.stdout);
    const recipes = parsed && parsed.recipes && typeof parsed.recipes === "object" ? parsed.recipes : null;
    if (!recipes) return null;
    const targets: Target[] = [];
    for (const name of Object.keys(recipes)) {
      const r = recipes[name];
      if (!r || r.private || name.startsWith("_")) continue;
      const params: any[] = Array.isArray(r.parameters) ? r.parameters : [];
      const needsArg = params.some((p) => p && p.default === null && p.kind !== "star");
      if (needsArg) continue;
      targets.push({ name, kind: "recipe", detail: typeof r.doc === "string" && r.doc ? r.doc : "just" });
    }
    return targets.length ? targets : null;
  } catch {
    return null;
  }
}

function tasks(rough: Rough, targets: Target[], isDefault: boolean): Task[] {
  const out: Task[] = [];
  const wraps = rough.wraps || "";
  const names = targets.map((t) => t.name);

  if (names.includes("build")) {
    out.push({
      label: "build",
      type: "process",
      command: "just",
      args: ["build"],
      group: { kind: "build", isDefault },
      detail: wraps ? "just → " + wraps : "just",
      builder: "just",
      problemMatcher: matcher("compilers"),
    });
  }

  for (const target of targets) {
    if (target.name === "build" || target.name === "clean") continue;
    const group = /^(test|check)$|-(test|check)$/.test(target.name)
      ? "test"
      : /^(build|dist)$/.test(target.name)
        ? "build"
        : undefined;
    out.push({
      label: target.name,
      type: "process",
      command: "just",
      args: [target.name],
      group,
      detail: target.detail,
      builder: "just",
      problemMatcher: matcher("compilers"),
    });
  }

  if (names.includes("clean")) {
    out.push({
      label: "clean",
      type: "process",
      command: "just",
      args: ["clean"],
      detail: "just",
      builder: "just",
    });
  }

  return out;
}

async function read(path: string): Promise<string | null> {
  try {
    return await workspace.readFile(path);
  } catch {
    return null;
  }
}
