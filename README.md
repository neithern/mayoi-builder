# mayoi-builder

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
| **Builders: Build** (`builder.build`) | Runs the folder's default build |
| **Run Build Task…** (`builder.run`) | Lists every task found |
| **Rerun Last Build task** (`builder.rerunLast`) | Runs the one that ran last |
| **Scan Builders Again** (`builder.reload`) | Reads the folder again |
| **Inspect a Project's Build System…** (`builder.inspect`) | Asks the build tool itself for its targets |
| **Show Builders** (`builder.showList`) | Shows the view |

A task's output opens in a tab of its own, with the command that ran it,
and the problems in it go to **Show Problems**.

## What it finds

| Build system | Marker | Targets |
| --- | --- | --- |
| Cargo | `Cargo.toml` | workspace members, `[[bin]]` names |
| CMake | `CMakeLists.txt` | `add_executable`, `add_library` |
| Meson | `meson.build` | `executable()`, `library()` |
| Swift PM | `Package.swift` | `.executable(name:)`, `.library(name:)` |
| Make | `GNUmakefile`, `Makefile`, `makefile` | its recipes |
| Xcode | `*.xcodeproj` | schemes, on asking |

A folder may have several: a Makefile that runs `xcodebuild` is the
folder's build, and Xcode is what it runs, so **Build** runs the Makefile.

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
- **No `.vscode/tasks.json`.** That is `mayoi-tasks`; installing both puts
  two panels in the sidebar.
- **No `dependsOn`.** A task runs alone.
- **No terminal.** Mayoi's plugin API has no terminal, so output is a tab
  and the problems are the panel.

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

## License

MIT
