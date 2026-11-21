# mayoi-builder

[English](README.md)

一个 [Mayoi](https://github.com/sorrycc/Mayoi) 插件：找出文件夹里的构建系统，
把它们的任务放进侧栏，不用手写任务文件。

它读项目**已经声明**的东西：Cargo workspace 的成员、CMakeLists.txt 的 target、
meson.build 的 executable、Package.swift 的 product、Makefile 的配方、
Xcode 工程的 scheme。

## 安装

```sh
mayoi plugin install neithern/builder
```

也可以把这个文件夹复制到 `~/.mayoi/plugins/builder`，或者用
`mayoi plugin dev .` 让 Mayoi 直接加载它。插件默认关闭：在设置窗口的
**插件**页打开，或在 `settings.json` 里写：

```json
{ "plugins": { "builder": { "enabled": true } } }
```

它不适合和 `mayoi-tasks` 同时安装：这个插件跑文件夹的构建，那个跑文件夹的
`.vscode/tasks.json`。两个一起装，侧栏会出现两个任务面板。

## 使用

| 命令 | 作用 |
| --- | --- |
| **默认构建**（`builder.build`） | 跑文件夹的默认构建 |
| **运行构建任务…**（`builder.run`） | 列出找到的全部任务 |
| **重新运行上次构建任务**（`builder.rerunLast`） | 跑上一次跑过的那个 |
| **重新扫描构建器**（`builder.reload`） | 重新读文件夹 |
| **精确内省项目构建系统…**（`builder.inspect`） | 让构建工具自己报出它的 target |
| **显示构建器**（`builder.showList`） | 显示这个视图 |

任务的输出在单独的标签页里打开，带上跑它的那条命令；输出里的问题进 **问题面板**。

## 能识别什么

| 构建系统 | 标志文件 | target |
| --- | --- | --- |
| Cargo | `Cargo.toml` | workspace 成员、`[[bin]]` 名 |
| CMake | `CMakeLists.txt` | `add_executable`、`add_library` |
| Go | `go.mod` | main 包，来自 `go list` |
| Gradle | `build.gradle`、`settings.gradle` | 模块，来自 `include` |
| Meson | `meson.build` | `executable()`、`library()` |
| npm | `package.json` | 它的 scripts |
| Swift PM | `Package.swift` | `.executable(name:)`、`.library(name:)` |
| Make | `GNUmakefile`、`Makefile`、`makefile` | 它的配方 |
| Xcode | `*.xcodeproj` | scheme，需要询问 |

一个文件夹可以有多个。当某个 Makefile 的配方调用了**另一个也在场的**构建系统时，
被调用的那个排前面，Makefile 排后面：只写了一行 `swift build` 的 Makefile
是 Swift 的一层壳，任务在 Swift 那边。

### Go

`go.mod` 只说模块名，不说它构建哪些程序，所以 main 包来自 `go list`。
程序按**包路径**构建和运行（`./cmd/app`），从不按名字。构建带 `-v`，
因为 `go build` 成功时**什么都不打印**。

### Gradle

跑的是项目自己的 `./gradlew`，从不是机器上碰巧装着的那个 `gradle`：
wrapper 锁定了这个项目构建时的版本。

Android 项目的**默认构建**是 `assembleDebug`，不是 `build`。`build` 会组装
所有变体，其中 release 变体在没有签名密钥时必然失败——而大多数项目都没配。
**build all** 才是完整构建，留给能签名的项目。

### npm

任务是 `package.json` 的 `scripts`，而且**只生成确实存在的那些**。
锁文件决定用哪个包管理器跑它们：有 `pnpm-lock.yaml` 就用 `pnpm` 跑，
因为 npm 会解析到与这个文件夹安装时不同的模块。

## 它怎么读项目

两步，而第二步从来不是必须的：

1. **读文件。** 扫描只读构建文件本身，不运行任何程序，不写任何东西。
   所以文件夹被列出时不会被改动，工具链没装的项目也照样列得出 target。
2. **问工具。** 文件说不出名字的 target——比如藏在变量后面的 CMake target——
   通过 **精确内省** 去问构建工具自己。这是唯一会写构建目录的路径。

一次扫描只在文件夹根上按名字问固定的那几个文件，每次一个调用，
**从不列目录**。调用次数就是标志文件的个数，与项目大小无关，与文件夹远近无关：
文件夹常常在另一台机器上，而每个调用都是一次往返。

## .mayoi/builders.json

可选，放在文件夹里。允许注释和尾逗号。

```jsonc
{
  "disable": ["make"],              // 不显示某个构建系统
  "prefer": "cmake",                // 默认构建给谁
  "extra": [                        // 手工加一条任务
    { "label": "release", "builder": "cargo", "command": "cargo", "args": ["build", "--release"] }
  ],
  "timeout": 15000,                 // 工具内省的超时，毫秒
  "cmake": {
    "policyMin": "auto",            // "auto"、"off"，或一个版本号
    "buildDir": "build"
  }
}
```

## 它不做什么

- **不做调试。** 这里没有 DAP 客户端：这个插件只跑构建。
- **不支持 `dependsOn`。** 一个任务单独跑。
- **没有终端。** Mayoi 的插件 API 没有终端，所以输出是标签页，问题是面板。

### 已知限制

- **Rust 的问题需要 `--message-format=short`。** 本插件生成的任务会带上它，
  这样一个问题落在一行里。你自己写的 `cargo` 任务不带这个参数时，
  rustc 会把位置打印在第二行，而面板不合并两行，所以那些问题不显示。
- **CMake 的配置错误进不了问题面板。** 那是两行结构，而 matcher 只读一行。
  它们留在任务的日志里。
- **条件编译里的 Swift product 找不到。** `Package.swift` 是程序，
  而 product 是从文本里读的。写在 `#if` 里的 product 会被漏掉，
  `swift package describe` 能找到它。
- **用通配符写的 Cargo 成员不跟随。** `members = ["crates/*"]` 指明的是一个集合，
  只有列目录才知道有哪些，而扫描不列目录。
- **不支持 Maven。** 有 `pom.xml` 的文件夹不会被识别。
- **Gradle 项目的任务是模块的，不是工程的。** 构建文件是程序，
  它产出什么任务取决于运行时解析的插件，所以扫描给出的是模块名，
  以及这一类模块都有的任务。
- **没有 SDK 的 Android 项目会说，而且构建不了。** 面板找的是
  `local.properties` 里的 `sdk.dir`；`ANDROID_HOME` 环境变量对插件不可见。

## 一个插件，所有窗口

插件对整个应用只运行**一次**，不是每个窗口一次，而它读的文件夹是**最前面那个窗口**的。
所以面板显示的是最前面窗口的任务，并跟随窗口切换。

## 许可证

MIT
