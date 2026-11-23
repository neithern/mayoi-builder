# mayoi-builder

[中文](README.zh-CN.md)

A [Mayoi](https://github.com/sorrycc/Mayoi) plugin that finds a folder's
build systems and puts their tasks in a sidebar view, without a task file
to write by hand.

It reads what the project already declares: a Cargo workspace's members, a
CMakeLists.txt's targets, a meson.build's executables, a Package.swift's
products, a Makefile's recipes, an Xcode project's schemes.

## Install

```sh
mayoi plugin install neithern/builder
```

Or copy this folder into `~/.mayoi/plugins/builder`, or point Mayoi at it
with `mayoi plugin dev .`. The plugin starts off: turn it on on the
**Plugins** page of the settings window, or in `settings.json`:

```json
{ "plugins": { "builder": { "enabled": true } } }
```

It is not meant to be installed beside `mayoi-tasks`: this plugin runs a
folder's builds, and that one runs a folder's `.vscode/tasks.json`. Both at
once would put two task panels in the sidebar.

## Use

| Command | What |
| --- | --- |
| **Default Build** (`builder.build`) | Runs the folder's default build |
| **Run Build Task…** (`builder.run`) | Lists every task found |
| **Rerun Last Build task** (`builder.rerunLast`) | Runs the one that ran last |
| **Scan Builders Again** (`builder.reload`) | Reads the folder again |
| **Inspect a Project's Build System…** (`builder.inspect`) | Asks the build tool itself for its targets |
| **Show Builders** (`builder.showList`) | Shows the view |

A task's output opens in a tab of its own, with the command that ran it,
and the problems in it go to **Show Problems**.

Click a task to see the line it would run, above whatever it printed. The
line is shown whether or not the task has run, so looking a command up is
a click, and it is there to be selected and copied.

The panel groups the tasks by project: a group is named for the name its
build system declares, or for the folder when it declares none, and its
description is the build system, as `make` or `gradle`.

## What it finds

| Build system | Marker | Targets |
| --- | --- | --- |
| Cargo | `Cargo.toml` | workspace members, `[[bin]]` names |
| CMake | `CMakeLists.txt` | `add_executable`, `add_library` |
| Go | `go.mod` | main packages, from `go list` |
| Gradle | `build.gradle`, `settings.gradle` | modules, from `include` |
| Meson | `meson.build` | `executable()`, `library()` |
| npm | `package.json` | its scripts |
| Swift PM | `Package.swift` | `.executable(name:)`, `.library(name:)` |
| Make | `GNUmakefile`, `Makefile`, `makefile` | its recipes |
| Xcode | `*.xcodeproj` | schemes, on asking |

A folder may have several. When a Makefile's recipes run another build
system that is here as well, that one comes first and the Makefile second:
a Makefile holding one `swift build` line is a shell over Swift, and
Swift is where the tasks are.

Of a Makefile, every target it declares is a task, `install` among them,
and only a target that builds is of the build group: `sign`, `install`
and `release` are what happens to a build afterwards, and a Makefile of
only those has no build to make the default. A row named **build** is the
file's own `build` target and nothing else.

### Go

`go.mod` names a module, not the programs it builds, so the main packages
come from `go list`. A program is built and run by its package path
(`./cmd/app`), never by its name. The build asks for `-v`, since `go
build` prints nothing at all when it succeeds.

### Gradle

The project's own `./gradlew` runs, never a `gradle` a machine happens to
have: the wrapper pins the version the project was built with.

An Android project's **Build** is `assembleDebug`, not `build`. `build`
assembles every variant, and the release one fails without a signing key,
which most projects do not have set up. **build all** is the whole build,
for a project that can sign.

### npm

Tasks are the `scripts` of `package.json`, and only the ones that are
there. A lockfile decides which package manager runs them: `pnpm-lock.yaml`
makes them `pnpm` scripts, since npm would resolve modules the folder was
not set up with.

## How it reads a project

Two steps, and the second never needed:

1. **The files.** A scan reads the build files themselves. It runs no
   program and writes nothing, so a folder is listed without being
   changed, and a project whose toolchain is not installed still lists its
   targets.
2. **The tool.** A target a file cannot name, as a CMake target behind a
   variable, is asked of the build tool itself, through **Inspect**. This
   is the only path that writes a build directory.

A scan asks for a fixed list of file names at the folder's root, one call
each, and never lists the folder. The count is the count of markers,
whatever the project holds, and however far the folder is: a folder is
often another machine, where every call is a round trip.

## .mayoi/builders.json

Optional, in the folder. Comments and trailing commas are allowed.

```jsonc
{
  "disable": ["make"],              // leave a build system out
  "prefer": "cmake",                // which one Build runs
  "extra": [                        // a task by hand
    { "label": "release", "builder": "cargo", "command": "cargo", "args": ["build", "--release"] }
  ],
  "timeout": 15000,                 // a tool's own answer, in milliseconds
  "cmake": {
    "policyMin": "auto",            // "auto", "off", or a version
    "buildDir": "build"
  }
}
```

## What it does not do

- **No debugging.** There is no DAP client here: this plugin runs builds.
- **No `dependsOn`.** A task runs alone.
- **No terminal.** A task's output is a tab and the problems are the
  panel; nothing is run in a terminal.

### Known limits

- **Rust problems need `--message-format=short`.** A task this plugin
  makes passes it, which puts a problem on one line. A `cargo` task of
  your own without it prints the place on a second line, which the panel
  does not join, so those problems do not show.
- **CMake's configure errors do not reach the problems panel.** They are
  two lines, and a matcher reads one. They stay in the task's log.
- **A Swift product behind a conditional is not found.** `Package.swift`
  is a program; the products are read from the text. A product declared
  inside an `#if` is missed, and `swift package describe` would find it.
- **A Cargo member named by a pattern is not followed.** `members = ["crates/*"]`
  names a set that only a listing tells, and a scan does not list.
- **Maven is not supported.** A folder with a `pom.xml` is not recognised.
- **A Gradle project's tasks are the module's, not the project's.** The
  build files are programs, and the tasks they make depend on plugins
  resolved while they run, so a scan names the modules and the tasks every
  module of that kind has.
- **An Android project without an SDK says so, and cannot build.**
  `local.properties` naming `sdk.dir` is what the panel looks for; the
  `ANDROID_HOME` variable is not visible to a plugin.
- **The log cannot scroll on its own.** A view has one scroll for its
  whole tree, and a `code` node has no height of its own, so a long log
  and the task list share it: the panel keeps the last 200 lines.
- **A task's command is selected and copied, not copied by a button.**
  Mayoi's plugin API has no clipboard, and the Copy Code button that a
  Markdown preview has is drawn by another renderer that a plugin's view
  does not use.

## One plugin, every window

A plugin runs once for the app, not once per window, and the folder it
reads is the window in front. So the panel shows the tasks of whichever
window is in front, and follows a change of window.

## License

MIT
