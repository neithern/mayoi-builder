// Finding the build systems of a folder, and the tasks they declare.
//
// The shape of this file follows one rule, which every number in the plan
// exists to serve: a scan costs a fixed number of calls, whatever the
// project is and however far the folder is. So a scan asks for the marker
// files by name, at the root, and never lists the folder: listing is what
// grows with a project, and what Mayoi matches on the thread that draws
// the window.

import { workspace } from "mayoi";
import { t as say } from "../i18n";
import {
  markerFiles,
  type Builder,
  type BuilderId,
  type Note,
  type Rough,
  type Target,
  type Task,
} from "./types";
import cargo from "./cargo";
import cmake from "./cmake";
import go from "./go";
import meson from "./meson";
import swift from "./swift";
import make from "./make";
import xcode from "./xcode";

// builders are the build systems known, in the order the panel tries them
// when nothing else says which one builds: the one that builds the most
// projects first.
const builders: Builder[] = [cargo, cmake, go, meson, swift, make, xcode];

// Found is a build system a folder has.
export interface Found {
  builder: Builder;
  rough: Rough;
  // tasks are what the panel lists, from the guess and from the program.
  tasks: Task[];
  // default marks the build system Build runs: one folder has one build,
  // whatever number of build systems it declares.
  isDefault: boolean;
}

// Scan is what one scan of a folder found.
export interface Scan {
  root: string;
  found: Found[];
  // notes are what a person should know about the project as a whole.
  notes: string[];
  // config is what .mayoi/builders.json said, read once with the scan.
  config: Config;
}

// Config is what .mayoi/builders.json says: which build systems to leave
// out, which one builds, and what to add by hand.
export interface Config {
  disable: BuilderId[];
  prefer?: BuilderId;
  extra: { label: string; builder: BuilderId; command?: string; args?: string[] }[];
  cmake: { policyMin: "auto" | "off" | string; buildDir: string };
  timeout: number;
}

// defaultConfig is what a folder without a settings file gets.
const defaultConfig: Config = {
  disable: [],
  extra: [],
  cmake: { policyMin: "auto", buildDir: "build" },
  timeout: 15000,
};

// readConfig reads .mayoi/builders.json, and says what it could not read
// rather than failing silent about a file a person wrote.
export async function readConfig(root: string): Promise<{ config: Config; error?: string }> {
  let text: string;
  try {
    text = await workspace.readFile(root + "/.mayoi/builders.json");
  } catch {
    return { config: defaultConfig }; // not there: the defaults
  }
  let raw: any;
  try {
    raw = JSON.parse(stripJSONC(text));
  } catch (e) {
    return { config: defaultConfig, error: ".mayoi/builders.json: " + String(e) };
  }
  const config: Config = {
    disable: Array.isArray(raw.disable) ? raw.disable.filter((d: any) => typeof d === "string") : [],
    prefer: typeof raw.prefer === "string" ? raw.prefer : undefined,
    extra: Array.isArray(raw.extra) ? raw.extra.filter((e: any) => e && e.label && e.builder) : [],
    cmake: {
      policyMin: raw.cmake && raw.cmake.policyMin !== undefined ? raw.cmake.policyMin : "auto",
      buildDir: (raw.cmake && raw.cmake.buildDir) || "build",
    },
    timeout: typeof raw.timeout === "number" && raw.timeout > 0 ? raw.timeout : defaultConfig.timeout,
  };
  return { config };
}

// stripJSONC drops what JSON does not take and VS Code allows: comments,
// and the commas before a closing brace or bracket.
// ported from mayoi-tasks
function stripJSONC(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") j += 2;
        else if (text[j] === '"') { j++; break; }
        else j++;
      }
      out += text.slice(i, j);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// present is the build systems whose marker files are at the folder's root.
//
// It asks for each marker by name, one call each, and stops there. A
// folder's listing tells the same thing more cheaply on a machine of one's
// own, and a scan does not ask for it: Mayoi matches a listing's globs on
// the thread that draws the window, so the cost of a listing is the size
// of the project, and the cost of these is the number of markers.
export async function present(root: string, config?: Config): Promise<Builder[]> {
  const here: Builder[] = [];
  for (const builder of builders) {
    if (builder.markers.length === 0) continue; // found another way, on asking
    if (config && config.disable.includes(builder.id)) continue;
    let seen = false;
    for (const marker of builder.markers) {
      try {
        const info = await workspace.stat(root + "/" + marker);
        if (info && !info.isDir) { seen = true; break; }
      } catch (e) {
      }
    }
    if (seen) here.push(builder);
  }
  return here;
}

// scan finds the build systems of a folder and the tasks they declare.
//
// It reads each one's files in turn and hands each to onFound as it is
// ready: a folder of four build systems shows the first before the fourth
// is read, so what a person waits for does not grow with how many there
// are.
export async function scan(
  root: string,
  config: Config,
  onFound?: (found: Found) => void,
): Promise<Scan> {
  const notes: string[] = [];
  const here = (await present(root, config)).filter((b) => !config.disable.includes(b.id));
  const found: Found[] = [];
  for (const builder of here) {
    let rough: Rough | null = null;
    try {
      rough = await builder.guess(root);
    } catch (e) {
      notes.push(builder.id + ": " + String(e));
    }
    if (!rough) continue;
    // A build system whose own files name no target has to be asked, when
    // there is a program to ask: a go.mod says a module and nothing about
    // the programs it builds, and reading every .go file for one is a scan
    // past what its cost allows. It is asked last of the targets, and a
    // tool that is missing leaves the guess as it was.
    if (!rough.targets.length && builder.ask) {
      try {
        const asked = await builder.ask(root, rough);
        if (asked && asked.length) rough.targets = asked;
      } catch (e) {
        notes.push(builder.id + ": " + String(e));
      }
    }
    const entry: Found = { builder, rough, tasks: [], isDefault: false };
    found.push(entry);
    if (onFound) onFound(entry);
  }
  order(found, config);
  for (const entry of found) {
    // Built after the order is settled, so that the one build that is the
    // default, and no other, says so: a task that says it is the default
    // when it is not is worse than one that does not say so at all.
    entry.isDefault = entry === found[0];
    entry.tasks = entry.builder.tasks(entry.rough, entry.rough.targets, entry.isDefault);
  }
  addExtra(found, config);
  return { root, found, notes, config };
}

// order puts the build system that builds the folder first: the one the
// settings name, then one a recipe runs, then a recipe that runs one, then
// the order of the list.
//
// The middle rule is what a project of several build systems needs. A
// Makefile that runs swift build is a shell over Swift: the tasks that
// come of it are Swift's, so Swift is what a person is looking at, and
// the Makefile is the way it is run. So the build system a recipe names
// comes first, and the recipe second.
function order(found: Found[], config: Config): void {
  const named = recipeRuns(found);
  found.sort((a, b) => {
    const ra = rank(a, named);
    const rb = rank(b, named);
    return ra - rb || builders.indexOf(a.builder) - builders.indexOf(b.builder);
  });
  if (config.prefer) {
    const at = found.findIndex((f) => f.builder.id === config.prefer);
    if (at > 0) found.unshift(found.splice(at, 1)[0]);
  }
}

// recipeRuns is the build system a Makefile's recipes run, when that build
// system is here as well: a Makefile that runs swift build in a folder of
// only a Makefile is just a Makefile.
function recipeRuns(found: Found[]): string {
  for (const entry of found) {
    const wraps = entry.rough.wraps;
    if (wraps && found.some((other) => other.builder.id === wraps)) return wraps;
  }
  return "";
}

// rank is how much a build system is the folder's build: 0 for the one a
// recipe runs, 1 for a recipe that runs one, 2 for the rest.
function rank(found: Found, named: string): number {
  if (named && found.builder.id === named) return 0;
  if (found.rough.wraps) return 1;
  return 2;
}

// addExtra adds the tasks .mayoi/builders.json gives by hand, after the
// build systems' own, where a task of the same label replaces one.
function addExtra(found: Found[], config: Config): void {
  for (const extra of config.extra) {
    const at = found.find((f) => f.builder.id === extra.builder);
    if (!at) continue;
    const task: Task = {
      label: extra.label,
      type: extra.command ? "process" : "shell",
      command: extra.command || extra.label,
      args: extra.args || [],
      builder: extra.builder,
      detail: ".mayoi/builders.json",
    };
    const seen = at.tasks.findIndex((t) => t.label === task.label);
    if (seen >= 0) at.tasks[seen] = task;
    else at.tasks.push(task);
  }
}

// allTasks are the tasks of a scan, the default build system's first.
export function allTasks(scan: Scan): Task[] {
  const out: Task[] = [];
  for (const entry of scan.found) for (const task of entry.tasks) out.push(task);
  return out;
}

// notesOf is what the panel says about a build system before a build: what
// its files said, in the language Mayoi shows.
export function notesOf(found: Found): string[] {
  const out: string[] = [];
  for (const note of found.rough.notes || []) out.push(noteText(note));
  return out;
}

// noteText words one note.
export function noteText(note: Note): string {
  switch (note.key) {
    case "initialised":
      return note.subject + ": " + say("builder.initialised");
    case "oldPolicy":
      return note.subject + ": " + say("builder.oldPolicy");
    case "unparsed":
      return note.subject + ": " + say("builder.truncated");
    default:
      return note.subject;
  }
}

// defaultBuilder is the build system Build runs.
export function defaultBuilder(scan: Scan): Found | undefined {
  return scan.found.find((f) => f.isDefault) || scan.found[0];
}

// markers are every file a scan asks about by name, for the settings page
// and for a person reading the README.
export function markers(): string[] {
  return markerFiles.slice();
}
