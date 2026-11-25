// The build tasks of a folder, from the build systems it already declares.
//
// The execution layer is ported from mayoi-tasks, which runs a task the
// same way: a shell in the background writes a log, the log is read as it
// grows, and the problems in it go to the panel. Only the finding of the
// tasks is new: mayoi-tasks reads .vscode/tasks.json, and this reads what
// Cargo, CMake, Meson, Swift, Make and Xcode already say about themselves.
//
// Everything below marked "ported from mayoi-tasks" is that plugin's code,
// kept as it was so that a fix to one can be read against the other.

import { commands, editor, events, languages, process, views, window, workspace, type Diagnostic, type ViewNode } from "mayoi";
import { t as say } from "./i18n";
import * as builders from "./builders";
import type { Task, Matcher } from "./builders/types";

// Ran is what the last run of a task was: how it ended, how long it took,
// and how many problems it found.
// ported from mayoi-tasks
interface Ran {
  code: number;
  seconds: number;
  problems: number;
  at: number;
}

// ported from mayoi-tasks
interface Log {
  label: string;
  body: string;
  full: string;
  running: boolean;
  code: number;
}

// A scan of the folder, kept until the folder or its build files change:
// drawing the panel reads this and never looks at the disk, since the
// panel is drawn again on every line of a running build.
//
// One plugin serves every window, so the folder a scan read is checked
// again whenever the panel is drawn or used. The view's tree is the
// plugin's and not a window's, so two windows show one panel; what this
// keeps right is that the tasks belong to the folder whose window asked,
// which is the one in front.
let scanned: builders.Scan | null = null;
let scanRoot = "";
// scanning is the scan going, and generation is the number of the scan
// that is: a scan that ends after a newer one started leaves its result
// alone, since the newer one was asked for later.
let scanning = false;
// rescan is whether a scan was asked for while one ran.
let rescan = false;
let generation = 0;

// history is how each task ended the last time it ran, by its label. It
// lives as long as the window does, and no longer.
// ported from mayoi-tasks
let history: { [label: string]: Ran } = {};

// running are the labels of the tasks going now, which the list marks.
const running = new Set<string>();

// logs is what each task printed the last time it ran, by its label.
const logs = new Map<string, Log>();

// show is the task whose log the view shows, "" for none.
let show = "";

// commandOpen is whether the chosen task's line is shown above its log. A
// person who has read it can put it away, and the row of the task brings
// it back: it is a panel of its own, not a part of the log.
let commandOpen = true;

// logLines is how much of a task's log the panel shows, its end: a
// build's failure is at the end, and the tasks above it keep their room.
// It is declared here, above the first draw, since a const read before
// its line is a ReferenceError, which would fail the plugin's load.
const logLines = 15;

// ranPaths are the files the run before found problems in.
// ported from mayoi-tasks
let ranPaths: string[] = [];
// last is the label of the task run last.
let last = "";

// findings is the panel's view of the scan, made once per scan and read on
// every draw.
let findings: builders.Found[] = [];

// scanError is why the last scan failed, shown in the view rather than
// only in a message that has gone by the time a person looks.
let scanError = "";

// tmpDir is a place of the system's own, named for what it holds: a task's
// log is handed through a file, and a file under the folder would be seen
// by a save, a commit and a diff, which have nothing to do with it.
// ported from mayoi-tasks
function tmpDir(kind: string): string {
  return "/tmp/mayoi-" + kind;
}

// shellQuote wraps a word for sh, so that a space or a quote in an
// argument goes as one word.
// ported from mayoi-tasks
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-.,:/=@%+]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// groupKind is the kind of a task's group, as "build" or "test", and
// whether it is the default of it.
// ported from mayoi-tasks
function groupKind(group: Task["group"]): { kind: string; isDefault: boolean } {
  if (!group) return { kind: "", isDefault: false };
  if (typeof group === "string") return { kind: group, isDefault: false };
  return { kind: group.kind || "", isDefault: !!group.isDefault };
}

// folderName is the last part of a folder's path, which is what a project
// is usually called.
function folderName(path: string): string {
  const at = path.replace(/\/+$/, "").lastIndexOf("/");
  return at >= 0 ? path.slice(at + 1) : path;
}

// commandOf is what a task would run, as a person would type it: its
// program and its arguments. A shell task names a whole line, which is
// its command, and the whole of it is what this answers.
function commandOf(task: Task): string {
  // The whole line, never cut: the panel shows it so that a person can
  // copy it out, and a command with its end missing is worse than none.
  return [task.command, ...(task.args || [])].join(" ");
}

// taskKey is what a task is kept by: its build system and its label.
//
// A label alone is not enough, which is why this is not mayoi-tasks':
// every build system names its build "build", so a folder of two of them
// has two tasks of that name, and a log or a result kept by the label
// alone would be one task's answer showing under another's name.
function taskKey(task: Task): string {
  return task.builder ? task.builder + "\u00b7" + task.label : task.label;
}

// variable is the value of one of VS Code's variables, or null for one
// that names a file while no editor of one has the keyboard.
// ported from mayoi-tasks
async function variable(name: string, path: string, file: string): Promise<string | null> {
  const root = (await workspace.root()) || "";
  switch (name) {
    case "workspaceFolder":
      return root;
    case "workspaceFolderBasename":
      return root.split("/").filter(Boolean).pop() || "";
    case "cwd":
      return root;
    case "file":
      return path || null;
    case "fileBasename":
      return file || null;
    case "fileBasenameNoExtension": {
      const at = file.lastIndexOf(".");
      return at > 0 ? file.slice(0, at) : file;
    }
    case "fileExtname": {
      const at = file.lastIndexOf(".");
      return at >= 0 ? file.slice(at) : "";
    }
    case "fileDirname": {
      const at = path.lastIndexOf("/");
      return at > 0 ? path.slice(0, at) : path;
    }
    case "relativeFile":
      return !path || !root ? null : path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
    default:
      return name.startsWith("env:") ? "" : null;
  }
}

// substitute replaces every ${...} of text, and names the first one it
// cannot take.
// ported from mayoi-tasks
async function substitute(text: string, path: string, file: string): Promise<{ text: string; missing?: string }> {
  let missing: string | undefined;
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "$" && text[i + 1] === "{") {
      const end = text.indexOf("}", i + 2);
      if (end > 0) {
        const name = text.slice(i + 2, end);
        const v = await variable(name, path, file);
        if (v === null) {
          missing = missing || name;
          out += text.slice(i, end + 1);
        } else {
          out += v;
        }
        i = end + 1;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return { text: out, missing };
}

// problemFrom is the problem a line of output names, as a matcher reads
// it: its path, its line and column from 0, and what it says.
// ported from mayoi-tasks
function problemFrom(m: Matcher, line: string) {
  let re: RegExp;
  try {
    re = new RegExp(m.regexp);
  } catch {
    return null;
  }
  const g = re.exec(line);
  if (!g) return null;
  const at = (n?: number) => (n && n > 0 && g[n] !== undefined ? g[n] : "");
  const path = at(m.file);
  const message = at(m.message);
  if (!path || !message) return null;
  const severity = at(m.severity).toLowerCase();
  return {
    path,
    line: Math.max(0, (parseInt(at(m.line), 10) || 1) - 1),
    column: Math.max(0, (parseInt(at(m.column), 10) || 1) - 1),
    severity: severity.startsWith("warn") ? "warning" : severity === "info" ? "info" : severity === "hint" ? "hint" : "error",
    message,
    code: at(m.code) || undefined,
  };
}

// diagnose writes the problems a run found, and clears those of the run
// before, which a clean build ends.
// ported from mayoi-tasks
async function diagnose(task: Task, output: string, before: string[]): Promise<{ paths: string[]; total: number }> {
  const matchers = !task.problemMatcher
    ? []
    : Array.isArray(task.problemMatcher) ? task.problemMatcher : [task.problemMatcher];
  const root = (await workspace.root()) || "";
  const found: { [path: string]: Diagnostic[] } = {};
  for (const line of output.split("\n")) {
    for (const m of matchers) {
      const p = problemFrom(m, line);
      if (!p) continue;
      const path = p.path.startsWith("/") ? p.path : root + "/" + p.path.replace(/^\.\//, "");
      (found[path] = found[path] || []).push({
        range: { start: { line: p.line, character: p.column }, end: { line: p.line, character: p.column + 1 } },
        severity: p.severity as any,
        message: p.message,
        code: p.code,
      });
      break; // one line, one problem
    }
  }
  let total = 0;
  for (const path of before) {
    if (!found[path]) await languages.clearDiagnostics(path);
  }
  for (const path of Object.keys(found)) {
    total += found[path].length;
    await languages.setDiagnostics(path, found[path], { source: task.label });
  }
  return { paths: Object.keys(found), total };
}

// scanFolder finds the build systems of the folder and reads their tasks.
//
// One scan runs at a time, and each is numbered: a scan that ends after a
// newer one started drops its result, since the newer one was asked for
// later and knows the folder as it is now.
async function scanFolder(redraw = true): Promise<void> {
  // A scan already going answers a request for another: what is running
  // reads the folder as it is now, and a second scan of the same folder
  // would read it twice for nothing. What it must not do is drop the
  // request and leave the panel as it was, which is why a scan that is
  // asked again starts another when it ends.
  if (scanning) {
    rescan = true;
    return;
  }
  scanning = true;
  const mine = ++generation;
  try {
    if (redraw) await renderList();
    const root = (await workspace.root()) || "";
    if (!root) {
      scanned = null;
      findings = [];
      scanRoot = "";
      return;
    }
    try {
      const { config, error } = await builders.readConfig(root);
      if (error) await window.notify("Builders: " + error);
      const scan = await builders.scan(root, config);
      if (mine !== generation) return; // a newer scan owns the panel
      scanned = scan;
      scanRoot = root;
      findings = scan.found;
      if (scan.notes.length) await window.notify("Builders: " + scan.notes[0]);
    } catch (e) {
      // A scan that failed says so, and keeps the folder: an empty panel
      // with no word of why is the one thing a person cannot act on.
      scanError = String(e);
      await window.notify("Builders: " + scanError);
    }
  } finally {
    scanning = false;
    await renderList();
    // A scan asked for while this one ran reads the folder now that it has
    // changed, rather than being lost.
    if (rescan) {
      rescan = false;
      void scanFolder(false);
    }
  }
}

// stale is whether the scan in hand is of another folder than the one in
// front. A folder is the window's, and the plugin's is the one in front,
// so opening a second window leaves this scanning for the first.
//
// The folder in front is asked at most once a tick: a draw happens on
// every line of a running build, and asking the host each time is a call
// per line for an answer that changes when a window does.
let frontSeen = { at: 0, root: "" };
async function frontRoot(): Promise<string> {
  const now = Date.now();
  if (now - frontSeen.at < 500) return frontSeen.root;
  const root = (await workspace.root()) || "";
  frontSeen = { at: now, root };
  return root;
}

async function stale(): Promise<boolean> {
  if (!scanned) return false;
  return scanRoot !== (await frontRoot());
}

// ensureScanned reads the folder in front when the scan in hand is of
// another one, and answers whether there is a scan at all.
async function ensureScanned(): Promise<boolean> {
  if (!scanned || (await stale())) {
    await scanFolder();
  }
  // The folder may have changed again while the scan ran.
  return !!scanned && scanRoot === ((await workspace.root()) || "");
}

// currentLog is the log the view draws: the task chosen, else none.
// ported from mayoi-tasks
function currentLog(): Log | null {
  return show ? logs.get(show) || null : null;
}

// taskAt is the task a key names, for the row a person clicked.
function taskAt(key: string): Task | undefined {
  return allTasks().find((task) => taskKey(task) === key);
}

// renderList draws the build systems of the folder, and the result of the
// task chosen.
//
// It never reads the disk: a running build draws the panel on every line
// it prints, and a panel that scanned again would scan a folder a dozen
// times a second.
async function renderList(): Promise<void> {
  try {
    await renderListNow();
  } catch (e) {
    scanError = "draw: " + String(e);
    try {
      await views.render("builder.list", { type: "stack", gap: 6, children: [
        { type: "text", text: "Builders could not draw: " + String(e).slice(0, 300) },
      ] });
    } catch { /* nothing else to say */ }
  }
}

async function renderListNow(): Promise<void> {
  // Another window coming forward asks for a panel of its own folder, and
  // the scan in hand is the one before it. It is started here, and what
  // this draws is the spinner: a draw happens on every line of a running
  // build, so a scan cannot be awaited in one.
  if (!scanning && scanned && (await stale())) {
    void scanFolder(false);
  }

  const children: ViewNode[] = [];
  const reload = {
    icon: "refresh",
    tooltip: say("builder.reload"),
    onClick: () => { void scanFolder(); },
  };

  if (scanning && !findings.length) {
    await views.render("builder.list", {
      type: "stack",
      gap: 6,
      children: [
        { type: "row", children: [{ type: "progress" }, { type: "text", text: say("builder.scanning") + "…", muted: true }] },
      ],
    });
    return;
  }

  if (!findings.length) {
    // No build system: the view keeps its place and its button, and says
    // what is looked for, rather than standing empty with no way on. A
    // scan that failed says that instead, and keeps the reason.
    await views.render("builder.list", {
      type: "stack",
      gap: 6,
      children: [{
        type: "tree",
        items: [{
          key: "builders-under",
          label: scanError ? say("builder.noBuilders") : say("builder.noBuilders"),
          description: scanError || say("builder.noBuildersHint"),
          open: false,
          actions: [reload],
        }],
      }],
    });
    return;
  }

  // The task the Build command runs, which the panel names: a row of a
  // plugin's view takes no weight and no colour of its own, so what it can
  // say, it says in its description.
  const built = buildKey("build");

  // One node per build system, each folding: a folder of a dozen targets
  // gives its room to the result when they are not wanted.
  const items = findings.map((entry) => {
    const notes = builders.notesOf(entry);
    const going = entry.tasks.some((task) => running.has(taskKey(task)));
    // The group is the project, and its row says which build system read
    // it: a folder of three build systems names one project three times
    // otherwise, which says less than the build system does. What is wrong
    // with the project is more to the point than either.
    const description = going
      ? say("builder.runningMark")
      : notes.length
        ? notes.join(" · ")
        : entry.builder.id;
    const rows = entry.tasks.map((task) => {
      const key = taskKey(task);
      const was = history[key];
      const isRunning = running.has(key);
      let mark = "";
      if (isRunning) mark = say("builder.runningMark");
      else if (was) mark = was.code === 0 ? "✓" : "✗";
      // A row says its task's name, and how its last run went. Which build
      // system it is of, its group says; what it would run, the log of a
      // run says, and the tooltip of its button names the command, since a
      // row of a view takes no tooltip of its own.
      //
      // The one Build runs says so, which a person looking for the button
      // to press is the one thing they need from this list.
      const isBuild = key === built;
      const detail = mark || (isBuild ? say("builder.defaultBuild") : "");
      return {
        key,
        label: task.label,
        description: detail,
        onClick: () => {
          show = key;
          // A row chosen again is a person asking for that task, so the
          // line it runs is shown again, even if it was put away.
          commandOpen = true;
          void renderList();
        },
        actions: [{
          // send, and not a check or a terminal: a row runs the task, so
          // a check would say it is already done, and a terminal would
          // say it opens one, which it does not.
          icon: "send",
          tooltip: say("builder.runOne") + ": " + commandOf(task),
          onClick: () => { void runAndShow(task); },
        }],
      };
    });
    return {
      key: "builder-" + entry.builder.id,
      // The project's own name when its build system says one, else the
      // folder's: a group named for its build system says what the
      // description already says, and a folder of one project has one of
      // those names.
      label: entry.rough.title || folderName(scanRoot),
      description,
      open: true,
      actions: [reload],
      children: rows,
    };
  });

  children.push({ type: "tree", items });

  // The line of the task chosen, above what it printed: a row is too narrow
  // for a command, and a command is what a person copies out of this panel.
  // It shows whether or not the task has run, so that looking a command up
  // is a click and no more.
  const chosen = show ? taskAt(show) : undefined;
  if (chosen && commandOpen) {
    // A row, as the log's is, and the word after the name: the same name
    // heads both, so the two are told apart by what they hold. The cross
    // puts it away, which the task's own row undoes by choosing it again.
    children.push({
      type: "list",
      items: [{
        key: "head-command",
        label: chosen.label + " · " + say("builder.commandLine"),
        actions: [{
          icon: "x",
          tooltip: say("builder.closeCommand"),
          onClick: () => { closeCommand(); },
        }],
      }],
    });
    children.push({ type: "code", text: commandOf(chosen), language: "shell" });
  }

  const shown = currentLog();
  if (shown) {
    const lines = shown.body.split("\n");
    children.push({
      type: "list",
      items: [{
        key: "head-output",
        // The word comes first and the result after it, so that a row of
        // two runs of one task keeps its width as the mark changes.
        label: shown.label + " · " + say("builder.log"),
        description: shown.running ? say("builder.runningMark") : shown.code === 0 ? "✓" : "✗ " + shown.code,
        actions: [
          { icon: "search", tooltip: say("builder.openLog"), onClick: () => { void openLog(); } },
          { icon: "trash", tooltip: say("builder.clearLog"), onClick: () => { clearLog(); } },
        ],
      }],
    });
    // A handful of lines, not the whole log. The panel shares one scroll
    // with the tasks, and a log of two hundred lines pushes them off it:
    // what a build's end says is in its last lines, and the whole is a
    // click away, in **Full Log**.
    children.push({ type: "code", text: lines.slice(-logLines).join("\n") });
  }
  await views.render("builder.list", { type: "stack", gap: 6, children });
}

// closeCommand puts the chosen task's line away. Choosing a task again
// brings it back, which is what the onClick of its row does.
function closeCommand(): void {
  commandOpen = false;
  void renderList();
}

// openLog shows the whole log of the last run in a tab, which the panel
// keeps only the end of.
// ported from mayoi-tasks
async function openLog(): Promise<void> {
  const l = currentLog();
  if (!l) return;
  // The task's key is what the tab is kept by, so asking for a task's log
  // again writes into the tab it opened before, rather than a new one for
  // every run. Mayoi refuses to replace a tab a person has edited, which
  // is the right answer for a log they changed by hand.
  const opts: {
    title: string;
    language: string;
    key: string;
    beside?: { windowId: number; documentId: number };
  } = {
    title: l.label + " · " + say("builder.log"),
    // A log is the build system's own words, and the highlighter that
    // reads them reads nothing of it well: plain text is what it is.
    language: "text",
    key: show,
  };
  // Beside the file being worked on, when one is, as Mayoi's own output
  // panels do: a build's log is read against the code it is about, and a
  // tab of its own away from it loses that. A window with no editor open
  // has nothing to stand beside, and the log opens as a tab instead.
  //
  // The reference is never null, and never zero: Mayoi numbers a window
  // the first time it is asked for one, and every document has an id. An
  // untitled document has one too, and a log may stand beside it.
  const ed = await editor.active();
  if (ed) {
    opts.beside = ed.document.ref;
  }
  await window.openText(l.full || l.body, opts);
}

// clearLog takes the chosen task's log away, keeping what the task is and
// what it last did: only the text of its output goes.
// ported from mayoi-tasks
function clearLog(): void {
  const l = currentLog();
  if (!l) return;
  // The log is kept by the key, which is what chosen it.
  logs.delete(show);
  void renderList();
}

// runAndShow runs a task, and draws the list anew as it begins and ends.
// ported from mayoi-tasks
async function runAndShow(task: Task): Promise<void> {
  show = taskKey(task);
  running.add(taskKey(task));
  await renderList();
  try {
    await runTask(task);
  } finally {
    running.delete(taskKey(task));
    await renderList();
  }
}

// runTask runs a task behind the bar's word for it, as a debug session
// does: a build of a minute says so where a session says so.
// ported from mayoi-tasks
async function runTask(task: Task): Promise<boolean> {
  return await window.progress(say("builder.running") + " " + task.label, () => runTaskNow(task));
}

// streamEveryLocal is how often the log is read: often enough that a
// build's lines come as they are written, and cheap enough for what a read
// costs. A read of a folder on a host is a round trip over ssh, so it
// reads less often and the lines come a little later.
// ported from mayoi-tasks
const streamEveryLocal = 250;
const streamEveryRemote = 800;

// ported from mayoi-tasks
async function streamEvery(): Promise<number> {
  try {
    return (await workspace.isRemote()) ? streamEveryRemote : streamEveryLocal;
  } catch {
    return streamEveryLocal;
  }
}

// streamCap is how much of the log the tab keeps, its end when the log is
// longer: a build's failure is at the end.
// ported from mayoi-tasks
const streamCap = 200000;

// startLive runs a task behind a log in the system's own temporary place,
// and reads the log as it grows.
// ported from mayoi-tasks
async function startLive(task: Task, command: string, argv: string[], cwd: string, head: string): Promise<{
  done: Promise<number>;
  append: (text: string) => void;
  text: () => string;
  finish: (code: number) => Promise<void>;
}> {
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = tmpDir("builders");
  const log = dir + "/" + task.label.replace(/[^\w.-]+/g, "-") + "-" + stamp + ".log";
  const codeFile = log + ".code";
  let shown = head;
  let stopped = false;

  const line =
    "mkdir -p " + shellQuote(dir) + " && " +
    "{ " + command + " " + argv.map(shellQuote).join(" ") + " ; echo $? > " + shellQuote(codeFile) +
    " ; } > " + shellQuote(log) + " 2>&1 < /dev/null & echo started";
  await process.run("sh", ["-c", line], { cwd });

  const run = logs.get(taskKey(task)) as Log;

  const write = async () => {
    if (stopped) return;
    run.body = shown.slice(head.length);
    run.full = shown;
    await renderList();
  };

  const readLog = async () => {
    let text: string;
    try {
      text = await workspace.readFile(log);
    } catch {
      return; // not written yet
    }
    if (text.length > streamCap) {
      const cut = text.slice(text.length - streamCap);
      const at = cut.indexOf("\n");
      text = "…\n" + (at >= 0 ? cut.slice(at + 1) : cut);
    }
    shown = head + text;
    await write();
  };

  const every = await streamEvery();
  let timer: any = null;
  const tick = async () => {
    if (stopped) return;
    await readLog();
    if (stopped) return;
    timer = setTimeout(tick, every);
  };
  timer = setTimeout(tick, 60);

  const done = (async () => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 120));
      let code: string;
      try {
        code = (await workspace.readFile(codeFile)).trim();
      } catch {
        continue;
      }
      if (code === "") continue;
      await readLog();
      return parseInt(code, 10) || 0;
    }
  })();

  return {
    done,
    // append puts text after what the program printed, which is how the
    // plugin says a thing of its own in the log: that a program that
    // printed nothing built, and why one that failed did not start.
    append: (t: string) => {
      shown = shown + t;
      void write();
    },
    text: () => shown.slice(head.length),
    finish: async (code: number) => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await readLog();
      await write();
      run.running = false;
      run.code = code;
      await renderList();
      try {
        await process.run("sh", ["-c", "rm -f " + shellQuote(log) + " " + shellQuote(codeFile)], { cwd });
      } catch {
        // nothing to do
      }
    },
  };
}

// runTaskNow runs a task: the program, in the folder, behind a log.
// ported from mayoi-tasks
async function runTaskNow(task: Task): Promise<boolean> {
  const ed = await editor.active();
  const path = ed?.document.path || "";
  const file = ed?.document.name || "";
  const cwd = await substitute(task.options?.cwd || "${workspaceFolder}", path, file);
  if (cwd.missing) {
    await window.notify("Builders: " + task.label + " asks for ${" + cwd.missing + "}, with no file open");
    return false;
  }
  const args: string[] = [];
  for (const a of task.args || []) {
    const v = await substitute(a, path, file);
    if (v.missing) {
      await window.notify("Builders: " + task.label + " asks for ${" + v.missing + "}, with no file open");
      return false;
    }
    args.push(v.text);
  }
  // The row of the result comes at once, before the program is even
  // started: a task of a minute shows where its output will be, turning.
  const key = taskKey(task);
  const run: Log = { label: task.label, body: "", running: true, code: -1, full: "" };
  logs.set(key, run);
  show = key;
  await renderList();

  // How the task's command goes to the program that runs it. VS Code's
  // "shell" names a whole line, and its "process" a program, its args
  // beside it: a program named as a line would be looked for under that
  // name, and found nowhere.
  const env = task.options?.env || {};
  const vars = Object.keys(env);
  const asShell = task.type !== "process" || !!task.shell || vars.length > 0;
  let command = task.command;
  let argv = args;
  let shown = [task.command, ...args].map(shellQuote).join(" ");
  if (asShell) {
    const assigns = vars.map((k) => k + "=" + shellQuote(env[k])).join(" ");
    const line = task.type === "shell"
      ? [task.command, ...args.map(shellQuote)].join(" ")
      : [shellQuote(task.command), ...args.map(shellQuote)].join(" ");
    command = "sh";
    argv = ["-c", assigns ? assigns + " " + line : line];
    shown = (assigns ? assigns + " " : "") + line;
  }

  const began = Date.now();
  const head = "$ " + shown + "\n" + (cwd.text ? "in " + cwd.text + "\n" : "") + "\n";
  let live;
  try {
    live = await startLive(task, command, argv, cwd.text, head);
  } catch (e) {
    // The program did not start: the row is still there to say so, rather
    // than turning for ever.
    run.running = false;
    run.code = -1;
    run.body = String(e);
    run.full = String(e);
    await renderList();
    return false;
  }
  let code = -1;
  try {
    code = await live.done;
  } catch (e) {
    code = -1;
    live.append(String(e));
  }
  const out = live.text();
  // A program that prints nothing is not one that did nothing, and a log
  // that holds only the command looks like a run that never started. What
  // it left behind is the answer a person came for: a build that says
  // nothing has built, and one that failed says why in its own words.
  if (!out.trim() && code === 0) {
    live.append(say("builder.quiet") + "\n");
  }
  await live.finish(code);
  const elapsed = Date.now() - began;
  const problems = await diagnose(task, out, ranPaths);
  ranPaths = problems.paths;
  history[taskKey(task)] = { code, seconds: elapsed, problems: problems.total, at: Date.now() };
  last = taskKey(task);
  return code === 0;
}

// allTasks are the tasks of the folder, the default build first.
function allTasks(): Task[] {
  return scanned ? builders.allTasks(scanned) : [];
}

// pickTask shows the tasks, the default build first.
// ported from mayoi-tasks
async function pickTask(): Promise<Task | undefined> {
  if (!(await ensureScanned())) {
    await window.notify("Builders: " + say("builder.noBuilders"));
    return undefined;
  }
  const tasks = allTasks();
  if (!tasks.length) {
    await window.notify("Builders: " + say("builder.noBuilders"));
    return undefined;
  }
  const order = tasks.slice().sort((a, b) => {
    const ga = groupKind(a.group);
    const gb = groupKind(b.group);
    return (gb.isDefault ? 1 : 0) - (ga.isDefault ? 1 : 0) ||
      (gb.kind === "build" ? 1 : 0) - (ga.kind === "build" ? 1 : 0);
  });
  // A label of a build system's own would be the same for two of them,
  // as every build system names its build "build", so the name says which
  // one: a person picking a task picks the build system's.
  const name = (task: Task) => (task.builder ? task.builder + " · " + task.label : task.label);
  const chose = await window.pick(
    order.map((task) => {
      const g = groupKind(task.group);
      return { label: name(task), description: g.isDefault ? say("builder.defaultBuild") : g.kind || task.detail || "" };
    }),
    { placeholder: say("builder.runOne") },
  );
  if (!chose) return undefined;
  return order.find((task) => name(task) === chose.label);
}

// byGroup is the task of a group: the default of it, else the first.
// ported from mayoi-tasks
async function byGroup(kind: string): Promise<Task | undefined> {
  return buildGroupOf(kind);
}

// buildGroupOf is byGroup without the scan, or asking the folder: the one
// task Build runs. The panel marks that very task, so the mark and the
// command cannot drift apart.
function buildGroupOf(kind: string): Task | undefined {
  const of = allTasks().filter((task) => groupKind(task.group).kind === kind);
  return of.find((task) => groupKind(task.group).isDefault) || of[0];
}

// buildKey is what Build names, by the key the panel keeps it by.
function buildKey(kind: string): string {
  const task = buildGroupOf(kind);
  return task ? taskKey(task) : "";
}

commands.register("builder.run", async () => {
  await views.reveal("builder.list");
  const task = await pickTask();
  if (task) await runTask(task);
});

commands.register("builder.build", async () => {
  if (!(await ensureScanned())) {
    await window.notify("Builders: " + say("builder.noTasks"));
    return;
  }
  const task = await byGroup("build");
  if (!task) {
    await window.notify("Builders: " + say("builder.noTask"));
    return;
  }
  await views.reveal("builder.list");
  await runTask(task);
});

commands.register("builder.rerunLast", async () => {
  const key = last;
  if (!key) {
    await window.notify("Builders: " + say("builder.noTask"));
    return;
  }
  // By the key, not the label: two build systems name their build the
  // same, and the one that ran last is the one with its build system.
  const task = allTasks().find((t) => taskKey(t) === key);
  if (!task) {
    await window.notify("Builders: " + key);
    return;
  }
  await runTask(task);
});

commands.register("builder.reload", async () => {
  scanned = null;
  await scanFolder();
});

commands.register("builder.showList", async () => {
  await views.reveal("builder.list");
});

// builder.inspect reads a build system's own program for the targets its
// files could not name: the one path in this plugin that writes a build
// directory, and one a person asks for.
commands.register("builder.inspect", async () => {
  await scanFolder();
  if (!scanned || !scanned.found.length) {
    await window.notify("Builders: " + say("builder.noBuilders"));
    return;
  }
  const chose = await window.pick(
    scanned.found.map((f) => ({ label: f.builder.id, description: f.rough.title || "" })),
    { placeholder: say("builder.inspect") },
  );
  if (!chose) return;
  const entry = scanned.found.find((f) => f.builder.id === chose.label);
  const ask = entry?.builder.ask;
  if (!entry || !ask) {
    await window.notify("Builders: " + chose.label);
    return;
  }
  await window.progress(say("builder.inspecting") + " " + chose.label, async () => {
    try {
      const root = scanned!.root;
      const targets = await ask(root, entry.rough);
      if (targets && targets.length) {
        entry.rough.targets = targets;
        entry.tasks = entry.builder.tasks(entry.rough, targets, entry.isDefault);
        findings = scanned!.found;
      }
    } catch (e) {
      await window.notify("Builders: " + String(e));
    }
  });
  await renderList();
});

// The view draws itself as it shows, and reads the folder again when it
// changes.
views.onShow("builder.list", async () => {
  const root = (await workspace.root()) || "";
  // A view is shown before the folder's build systems are known whenever a
  // scan is going, so it is drawn as it is, which is the spinner, rather
  // than left as it was under another view. A scan that is going already
  // reads the folder as it is now, and one that is not starts.
  if (scanning) {
    await renderList();
    return;
  }
  if (!scanned || scanRoot !== root) await scanFolder();
  else await renderList();
});

// A build file saved reads the build systems again: the list follows the
// file.
events.on("editor.didSave", (e: any) => {
  const path = e?.path || "";
  if (!path) return;
  for (const marker of ["Cargo.toml", "CMakeLists.txt", "meson.build", "Package.swift", "GNUmakefile", "Makefile", "makefile", "project.pbxproj", "contents.xcworkspacedata", "builders.json"]) {
    if (path.endsWith("/" + marker)) {
      scanned = null;
      void scanFolder();
      return;
    }
  }
});

// Another folder: what the one before ran, and what it printed, went with
// it.
events.on("workspace.changed", () => {
  scanned = null;
  findings = [];
  scanRoot = "";
  ranPaths = [];
  logs.clear();
  history = {};
  show = "";
  last = "";
  void scanFolder();
});

// And once as the plugin starts: a view shown while this code was still
// being read asked its plugin for a tree before it could answer, and the
// view then stood empty until it was shown again.
//
// The scan starts here too, and not only when the view is shown. A plugin
// starts when the editor does, and a sidebar that already shows this view
// is never shown again: nothing would ask for the folder's build systems,
// and the panel would stand empty until a person switched away and back,
// which is the one thing an empty panel must not need.
//
// It starts a turn later, and is not awaited: Mayoi gives a plugin two
// seconds to load, and a scan of a folder that runs a program to find its
// targets outlasts that. A scan that ran here would fail the load itself,
// and the plugin would be off, which is far worse than a panel that fills
// a moment late.
setTimeout(() => { void scanFolder(); }, 0);


