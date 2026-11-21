# A Mayoi plugin

This folder is a plugin for [Mayoi](https://github.com/sorrycc/Mayoi), a code editor written in Go.
Notes for agents and people working on it.

## How it runs

- `plugin.json` declares the plugin: its `name`, its entry module `main`, when it starts
  (`activation`) and what it adds (`contributes`). Every id starts with `builder.`.
- `main.ts` runs in Mayoi's own JavaScript engine (moejs), not Node. TypeScript runs as it is,
  with no build step.
- The API is the `mayoi` module; its types are in `mayoi.d.ts`. Every call that touches the
  editor returns a promise.
- There is no `require`, no `node:` module and no npm package at run time. Import relative files
  of this folder.

## Try it

```sh
mayoi plugin dev .      # load this folder into Mayoi, and again on each save
mayoi run builder.reload
```

Logs from `console.log` and errors show in Mayoi under **Plugins: Show Log**.

## Shapes

| File | What |
| --- | --- |
| `builders/types.ts` | the `Task`, `Builder` and `Target` interfaces, and the problem matchers |
| `builders/index.ts` | finding the build systems, the order, the settings file |
| `builders/<system>.ts` | one build system: its markers, its guess, its tasks |
| `main.ts` | the execution layer, ported from mayoi-tasks, and the panel |

## Rules this plugin keeps

1. **A scan reads files and runs no program.** `guess` never writes and never spawns: a folder is
   scanned without being changed, and a project without its toolchain still lists.
2. **A scan never lists the folder.** It asks for marker files by name. Listing grows with the
   project, and Mayoi matches a listing's globs on the thread that draws the window.
3. **Every call is awaited.** A folder may be another machine, where each call is a round trip, so
   k calls are k round trips and never free.
4. **A decision is explained by calls, threads or sizes, never by a stopwatch.** A number measured
   on one machine does not say what another does.

## Limits

- A command's JavaScript that runs for 10 seconds without a break is stopped, and so is a plugin
  that keeps more than 256 MiB.
- A file larger than 1 MiB is not loaded.
