// What a build system is, to this plugin: its name, the files that say it
// is there, and how to read it.
//
// The shape matters as much as the parsers: a build system is read in two
// steps, a guess from the text it declares, and, when a program can be
// asked, what the program itself says. The guess comes first because it
// costs a file read and no process, and because it is what a folder shows
// before anything runs.

// A task of .vscode/tasks.json, of the part of VS Code's that a build
// needs: the program, its arguments, where, and the regexp that reads its
// problems.
// ported from mayoi-tasks
export interface Task {
  label: string;
  type?: "process" | "shell";
  command: string;
  args?: string[];
  options?: { cwd?: string; env?: { [k: string]: string } };
  group?: string | { kind: string; isDefault?: boolean };
  detail?: string;
  problemMatcher?: Matcher | Matcher[];
  shell?: boolean;
  // builder names the build system the task came from: the panel groups by
  // it, and .mayoi/builders.json turns one off by it.
  builder?: BuilderId;
}

export interface Matcher {
  regexp: string;
  file?: number;
  line?: number;
  column?: number;
  severity?: number;
  message?: number;
  code?: number;
}

// BuilderId is one build system this plugin knows.
export type BuilderId = "cargo" | "cmake" | "go" | "gradle" | "meson" | "npm" | "swift" | "make" | "xcode";

// Problem is a matcher of a build system's own, named for the messages it
// reads. Every build system that compiles C, C++ or Swift says a problem
// the same way, so most of them share compilers'.
export type Problem = "rust" | "compilers" | "go";

const compilers: Matcher = {
  // A line as gcc, clang and swiftc write one: the path, the line, the
  // column, then what is wrong. The code in brackets, as -Wint-conversion,
  // comes last and is taken when it is there.
  regexp: "^(.+?):(\\d+):(\\d+): (error|warning|note|fatal error): (.+?)(?: \\[(-[A-Za-z0-9=_-]+)\\])?$",
  file: 1,
  line: 2,
  column: 3,
  severity: 4,
  message: 5,
  code: 6,
};

const rust: Matcher = {
  // cargo with --message-format=short, which is the only way a rust
  // problem fits one line: src/main.rs:1:26: error[E0308]: mismatched
  // types. Without that flag rustc writes the place on a line of its own,
  // which a matcher that reads a line cannot join.
  regexp: "^(.+?):(\\d+):(\\d+): (error|warning)(?:\\[([A-Z]\\d+)\\])?: (.+)$",
  file: 1,
  line: 2,
  column: 3,
  severity: 4,
  code: 5,
  message: 6,
};

const go: Matcher = {
  // The go command names no severity: everything it prints about a file is
  // an error, in the same shape as a compiler's.
  regexp: "^(.+?):(\\d+):(\\d+): (.+)$",
  file: 1,
  line: 2,
  column: 3,
  message: 4,
};

// matcher is the problem matcher of a kind.
export function matcher(kind: Problem): Matcher {
  switch (kind) {
    case "rust":
      return rust;
    case "go":
      return go;
    default:
      return compilers;
  }
}

// Rough is what reading a project's files says, before any program is
// asked: the targets it declares, and what is worth telling a person about
// how it would go.
export interface Rough {
  // targets are the names a build system declares, as an executable, a
  // library or a recipe. A guess may be empty: a project's own files can
  // hide its targets behind code that only runs at configure time.
  targets: Target[];
  // title is what the build system calls the project, when it says.
  title?: string;
  // notes are things a person should know before a build starts, as a
  // submodule that is not there or a version that is too old. They show on
  // the panel, and they are why a build that cannot work says so first.
  notes?: Note[];
  // wraps is the build system this one's recipes run, as a Makefile that
  // runs xcodebuild: it decides which build the folder's Build is, and it
  // is not something to show, since a person reading the tasks sees the
  // tasks. Empty when this one stands alone.
  wraps?: string;
  // tool is the program this one's own tasks run through, when the folder
  // has a choice of them: a package.json in a folder with a pnpm lockfile
  // is a pnpm project, and npm would resolve other modules than the ones
  // it was set up with. Empty when the build system names one program.
  tool?: string;
  // bundle is the project bundle a build system names its commands by,
  // when it is not a fixed file name: Xcode's <name>.xcodeproj or
  // <name>.xcworkspace.
  bundle?: string;
  // platform is the target OS a project builds for when a build system
  // needs it to pick a destination or a run command (e.g. Xcode "macos" / "ios").
  platform?: "macos" | "ios";
  // destination is the xcodebuild -destination value discovered for an iOS
  // project or set in .mayoi/builders.json.
  destination?: string;
}

// Target is one thing a build system can build.
export interface Target {
  name: string;
  // kind is what the target is, in the build system's own terms: an
  // executable, a library, a recipe, a crate's binary.
  kind: "executable" | "library" | "recipe" | "bin" | "product" | "member";
  // detail says what the name alone does not, as where it was declared.
  detail?: string;
  // path is what the build system's own command takes for this target,
  // when a name is not enough: a Go program is built by its package path,
  // since two packages may share the name of the binary they write.
  path?: string;
  // guessed marks a target whose name was worked out rather than read: a
  // variable that could not be followed, or a build file that could not be
  // parsed. The panel says so, since a guess is what a person checks first.
  guessed?: boolean;
}

// Note is something to tell before a build, about the project as it is.
export interface Note {
  // key names what the note is about, so that translations can word it.
  key:
    // a folder a build file adds, which is not there: a submodule not set up.
    | "initialised"
    // a project that asks for a version of its build system this one no
    // longer takes.
    | "oldPolicy"
    // a build file this plugin could not read, as one that is not JSON.
    | "broken"
    // a project that asks for a toolchain this folder does not name, as an
    // Android project without an SDK.
    | "missingSdk"
    // something a build file names that a scan did not follow.
    | "unparsed";
  // subject is what the note is about, as the folder of a submodule, the
  // version a project asks for, or the file that could not be read.
  subject: string;
}

// Builder is one build system.
//
// Reading a project happens in two steps and no more: guess reads what the
// project's own files declare, which costs a file read and never a
// process, and ask, when a program can be asked, says what the program
// itself reports. guess is what the panel shows, and it must finish on a
// project whose tools are not installed, so ask is never the only path.
export interface Builder {
  id: BuilderId;
  // markers are the files whose presence at the folder's root says this
  // build system is here, relative to the root.
  markers: string[];
  // present finds a build system whose marker is named after the folder
  // (as <folder>.xcodeproj/project.pbxproj), without listing the folder.
  // Used when markers is empty.
  present?(root: string): Promise<boolean>;
  // guess reads the project's files. It never runs a program and never
  // writes one: a folder is scanned without being changed.
  guess(root: string): Promise<Rough | null>;
  // ask runs the build system's own program, when it is installed, for
  // targets that guess could not read. It returns the targets it could
  // name, and may return none: a tool that is missing, too old or slow to
  // answer leaves the guess standing.
  ask?(root: string, rough: Rough, config?: unknown): Promise<Target[] | null>;
  // tasks makes the tasks of the targets, each one a command a person
  // could have typed. isDefault marks the one Build runs.
  tasks(rough: Rough, targets: Target[], isDefault: boolean, config?: unknown): Task[];
}

// markerFiles are every file a build system is found by, all of them at
// the folder's root. A scan asks for these and nothing else, since asking
// for a file costs a call, and every call may go to another machine.
export const markerFiles: string[] = [
  "Cargo.toml",
  "CMakeLists.txt",
  "go.mod",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "meson.build",
  "package.json",
  "Package.swift",
  "GNUmakefile",
  "Makefile",
  "makefile",
];
