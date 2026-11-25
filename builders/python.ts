// Python: a project whose build and scripts are declared in pyproject.toml.
//
// A scan reads pyproject.toml and checks lockfiles to choose the runner
// (uv, poetry, pdm, local .venv, or python3), matching npm's lockfile rule:
// running through the wrong environment resolves different packages.

import { workspace } from "mayoi";
import { matcher, type Builder, type Matcher, type Rough, type Target, type Task } from "./types";

// pythonTraceback matches File "/path/file.py", line 42 from Python tracebacks,
// alongside compilers' path:line:col: severity: message (used by ruff / mypy).
const pythonTraceback: Matcher = {
  regexp: '^\\s*File "(.+?)", line (\\d+)(?:, in (.+))?$',
  file: 1,
  line: 2,
  message: 3,
};

const ruffLine: Matcher = {
  regexp: "^(.+?\\.py):(\\d+):(\\d+): ([A-Z]+\\d+) (.+)$",
  file: 1,
  line: 2,
  column: 3,
  code: 4,
  message: 5,
};

const pythonMatchers: Matcher[] = [matcher("compilers"), ruffLine, pythonTraceback];

const builder: Builder = {
  id: "python",
  markers: ["pyproject.toml"],
  guess,
  tasks,
};
export default builder;

// runners are the lockfiles / virtualenvs that decide how commands run.
const runners: { file: string; tool: string }[] = [
  { file: "uv.lock", tool: "uv" },
  { file: "poetry.lock", tool: "poetry" },
  { file: "pdm.lock", tool: "pdm" },
  { file: ".venv/bin/python", tool: ".venv" },
];

async function guess(root: string): Promise<Rough | null> {
  const text = await read(root + "/pyproject.toml");
  if (text === null) return null;

  const title = sectionValue(text, "project", "name") || sectionValue(text, "tool.poetry", "name") || basename(root);
  const targets: Target[] = [];
  const seen = new Set<string>();
  const push = (t: Target) => {
    const k = t.kind + ":" + t.name;
    if (seen.has(k)) return;
    seen.add(k);
    targets.push(t);
  };

  if (/^\[build-system\]/m.test(text)) {
    push({ name: "build", kind: "recipe", detail: "build-system" });
  }

  // CLI entry points under [project.scripts] or [tool.poetry.scripts].
  for (const section of ["project.scripts", "tool.poetry.scripts"]) {
    for (const name of sectionKeys(text, section)) {
      push({ name, kind: "executable", detail: "script" });
    }
  }

  if (/^\[tool\.pytest(?:\.|\])/m.test(text) || /["']pytest(?:[><=!~;,\s"']|$)/.test(text)) {
    push({ name: "test", kind: "recipe", detail: "pytest" });
  }
  if (/^\[tool\.ruff(?:\.|\])/m.test(text) || /["']ruff(?:[><=!~;,\s"']|$)/.test(text)) {
    push({ name: "lint", kind: "recipe", detail: "ruff" });
  }
  if (/^\[tool\.mypy(?:\.|\])/m.test(text)) {
    push({ name: "typecheck", kind: "recipe", detail: "mypy" });
  }

  let tool = "python3";
  for (const one of runners) {
    if (await existsFile(root + "/" + one.file)) {
      tool = one.tool;
      break;
    }
  }

  return { targets, title, tool };
}

function sectionBody(text: string, header: string): string {
  const escaped = header.replace(/\./g, "\\.");
  const re = new RegExp("^\\[" + escaped + "\\]\\s*$", "m");
  const m = re.exec(text);
  if (!m) return "";
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^\[/m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function sectionValue(text: string, header: string, key: string): string {
  const body = sectionBody(text, header);
  if (!body) return "";
  const m = body.match(new RegExp("^\\s*" + key + "\\s*=\\s*[\"']([^\"']+)[\"']", "m"));
  return m ? m[1] : "";
}

function sectionKeys(text: string, header: string): string[] {
  const body = sectionBody(text, header);
  if (!body) return [];
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const clean = line.replace(/#.*$/, "").trim();
    if (!clean) continue;
    const m = clean.match(/^["']?([A-Za-z0-9_.-]+)["']?\s*=/);
    if (m) out.push(m[1]);
  }
  return out;
}

function runCmd(tool: string, prog: string, args: string[], isModule = false): { command: string; args: string[] } {
  if (tool === "uv" || tool === "poetry" || tool === "pdm") {
    return { command: tool, args: ["run", prog, ...args] };
  }
  if (tool === ".venv") {
    return isModule
      ? { command: ".venv/bin/python", args: ["-m", prog, ...args] }
      : { command: ".venv/bin/" + prog, args };
  }
  return isModule
    ? { command: "python3", args: ["-m", prog, ...args] }
    : { command: prog, args };
}

function tasks(rough: Rough, targets: Target[], isDefault: boolean): Task[] {
  const tool = rough.tool || "python3";
  const out: Task[] = [];
  const has = (name: string) => targets.some((t) => t.kind === "recipe" && t.name === name);

  if (has("build")) {
    const cmd =
      tool === "uv" || tool === "poetry" || tool === "pdm"
        ? { command: tool, args: ["build"] }
        : tool === ".venv"
          ? { command: ".venv/bin/python", args: ["-m", "build"] }
          : { command: "python3", args: ["-m", "build"] };
    out.push({
      label: "build",
      type: "process",
      command: cmd.command,
      args: cmd.args,
      group: { kind: "build", isDefault },
      detail: tool,
      builder: "python",
      problemMatcher: pythonMatchers,
    });
  }

  for (const target of targets) {
    if (target.kind !== "executable") continue;
    const cmd = runCmd(tool, target.name, [], false);
    out.push({
      label: "run " + target.name,
      type: "process",
      command: cmd.command,
      args: cmd.args,
      detail: tool + " · script",
      builder: "python",
      problemMatcher: pythonMatchers,
    });
  }

  if (has("test")) {
    const cmd = runCmd(tool, "pytest", [], true);
    out.push({
      label: "test",
      type: "process",
      command: cmd.command,
      args: cmd.args,
      group: "test",
      detail: tool + " · pytest",
      builder: "python",
      problemMatcher: pythonMatchers,
    });
  } else {
    const cmd =
      tool === "uv" || tool === "poetry" || tool === "pdm"
        ? { command: tool, args: ["run", "python", "-m", "unittest"] }
        : tool === ".venv"
          ? { command: ".venv/bin/python", args: ["-m", "unittest"] }
          : { command: "python3", args: ["-m", "unittest"] };
    out.push({
      label: "test",
      type: "process",
      command: cmd.command,
      args: cmd.args,
      group: "test",
      detail: tool + " · unittest",
      builder: "python",
      problemMatcher: pythonMatchers,
    });
  }

  if (has("lint")) {
    const cmd = runCmd(tool, "ruff", ["check", "."], true);
    out.push({
      label: "lint",
      type: "process",
      command: cmd.command,
      args: cmd.args,
      detail: tool + " · ruff",
      builder: "python",
      problemMatcher: pythonMatchers,
    });
  }

  if (has("typecheck")) {
    const cmd = runCmd(tool, "mypy", ["."], true);
    out.push({
      label: "typecheck",
      type: "process",
      command: cmd.command,
      args: cmd.args,
      detail: tool + " · mypy",
      builder: "python",
      problemMatcher: pythonMatchers,
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

async function existsFile(path: string): Promise<boolean> {
  try {
    const info = await workspace.stat(path);
    return !!info && !info.isDir;
  } catch {
    return false;
  }
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  return at >= 0 ? trimmed.slice(at + 1) : trimmed;
}
