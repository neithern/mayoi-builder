# 构建器识别插件（mayoi-builders）实施方案

> 目标：识别项目中常见构建器的配置文件，生成构建任务列表，复用已有的任务执行能力。
>
> 本方案修订自 `mayoi-tasks` 仓库的 BUILDERS-PLAN.md，修订依据是对 Mayoi 0.23.0 插件 API 源码的核实。
>
> **本方案中出现的所有耗时数字只用于否决某个设计，不用于批准某个捷径。**
> 任何设计决策的理由必须是调用次数、线程归属或数据规模，不能是「本机实测够快」。

---

## 〇、方法论约束（最高优先级，实现时不得违反）

原 BUILDERS-PLAN 第三节已经写明「同步还是异步不看本机耗时」，但后续章节又用本机数字做设计依据，
自相矛盾。本章把这条固化为约束：

1. **本机实测数字只有一种用途：证明某个操作慢到不可接受，用来否决方案。**
   绝不用于证明「某操作够快，可以走捷径」。
2. **每个 `workspace.*` 调用在远端文件夹上都是一次独立 ssh 往返。**
   `vfs.Stat` → `remote.Lookup` → `c.Stat`（`internal/vfs/vfs.go:28-32`），
   `Conn.Run` 每次起一个 ssh 子进程走 ControlMaster（`internal/remote/conn.go:631-652`）。
   这些调用**不会**被合批。本机的 0ms 在同城 SSH 上是 14ms，跨洲是 200ms。
   因此：任何 k 次顺序调用都可能是 k×RTT，**不能假设它是本机**。
3. **每个文件/进程调用都必须 `await`，没有例外。**
4. **默认路径的调用次数有硬上限**，与项目规模、链路质量无关。

---

## 一、目标与边界

### 要做

1. 扫出项目里存在的构建器：Cargo / CMake / Meson / Swift PM / Make / Xcode
2. 从各构建器**自己的元数据**推出可执行的构建任务（target、profile、workspace 成员）
3. 任务进入**已有的任务面板**，复用现有的执行、流式输出、问题面板能力

### 不做

- 不做构建器本身的封装（不重写 `cargo build` 的行为）
- 不做增量构建分析（构建器自己会做）
- 不替代 `.vscode/tasks.json`：本插件不读它，两者不同时安装
- 不做调试（DAP / lldb-dap 不移植）

---

## 二、现状：tasks 插件可复用的资产

| 能力 | 位置（mayoi-tasks main.ts） | 处理 |
|---|---|---|
| `Task` 数据模型 | 11-21 行 | 抄，加 `builder` 字段 |
| `stripJSONC` | 66-92 行 | 抄 |
| `variable()` / `substitute()` | 96-184 行 | 抄 |
| `groupKind()` | 237-241 行 | 抄 |
| `tmpDir` / `shellQuote` / `tail` | 249-265 行 | 抄 |
| `problemFrom()` | 269-291 行 | 原样抄 |
| `diagnose()` + `ranPaths` | 296-328 行 | 原样抄 |
| `renderList()` | 340-457 行 | 改：按构建器分组 |
| `openLog` / `clearLog` / `runAndShow` / `reloadAndShow` | 461-497 行 | 抄 |
| `runTask()` / `runTaskNow()` | 501-588 行 | 抄 |
| `LiveRun` / `streamEvery` | 592-621 行 | 抄 |
| `startLive()` | 622-737 行 | 抄 |
| `pickTask` / `byGroup` / 命令 | 740-815 行 | 改：命令面收缩 |
| `Log` / `logs` / `currentLog` | 857-874 行 | 抄 |
| **调试全部** | 876-1219 行 + `debug.ts` + `dap.ts` | **不抄** |

可抄约 700 行，其中 90% 原样。每处标 `// ported from mayoi-tasks`。

---

## 三、Mayoi API 的关键约束（已核实）

| 约束 | 证据 | 影响 |
|---|---|---|
| `process.run` 是缓冲式的，结束才返回 | `cmd/mayoi/pluginapi.go:633-659` | 内省必须短，或异步后台 |
| `process.run` 默认超时 60s，**超时会 kill 进程** | `pluginapi.go:636-650` | 内省必须显式传 timeout |
| 没有终端 API | API 31 个方法无 terminal | 构建丢不进终端 |
| 插件之间不能 import | `internal/plugin/runtime.go:129-145` | 执行层只能复制 |
| `button` 节点忽略 `icon`、无 `disabled` | `cmd/mayoi/pluginviews.go:423-434` | 面板只能用文字按钮 |
| 行 `actions` 只在悬停时显示 | `pluginviews.go:592` | 常驻图标做不到 |
| 图标白名单约 34 个，无 play/arrow | `cmd/mayoi/pluginpick.go:194-273` | 运行按钮用 check 或文字 |
| 视图节点 13 种 | `pluginviews.go:316-451` | 不能用表格 |
| `findFiles` 的匹配在主线程线性扫描 | `pluginapi.go:430-446` | 成本随索引规模增长，默认路径禁用 |
| `findFiles` 最多等索引 30s | `pluginapi.go:414-429` | 不能作为首屏路径 |
| `window.progress` 用标题字符串做标识 | `pluginapi.go:501` | 同标题并发会删错 |
| `BusyLimit = 10s` 测「JS 连续运行不中断」 | `internal/plugin/runtime.go:64,307` | 同步解析循环会触发 |
| `ActivateLimit = 2s` | `runtime.go:66,242` | 激活不能做重活 |
| `vfs.WriteFile` 会 `MkdirAll` 父目录 | `internal/vfs/vfs.go:167` | 一次 writeFile 能建整条路径 |
| `storage` 是同步的 `callSync` | `internal/plugin/prelude.js:170-172` | 只用于小配置，不用于文件 |

### API 缺口（建议 Mayoi 侧补，不阻塞本插件）

| 缺口 | 现状 | 建议 |
|---|---|---|
| 无批量 stat | `vfs.StatMany` 已有（`vfs.go:50-75`，一次往返），插件 API 未暴露 | 暴露 `workspace.statMany(paths)` |
| 无目录列举 | 只有 glob 的 `findFiles`，且匹配在主线程 | 暴露 `workspace.readDir(path)` |
| 无流式进程输出 | `process.run` 缓冲式 | 暴露 `process.spawn`（约 40 行） |
| `button` 无 icon/disabled | `pluginviews.go:423` | 读 `Icon` 与 `Disabled`（约 10 行） |

---

## 四、目录结构

插件名 `builder`（已核实与 Mayoi 内置 8 个插件不冲突），仓库 `neithern/builder`。

```
mayoi-builder/
  plugin.json          插件清单：命令、视图、激活条件
  main.ts              执行层 + 面板（从 mayoi-tasks 抄）
  i18n.ts              三语文案
  builders/
    types.ts           Builder 接口、Task 模型、BuilderId
    index.ts           发现：根标记探测、派发、优先级、缓存、单飞
    cargo.ts
    cmake.ts
    meson.ts
    swift.ts
    make.ts
    xcode.ts
  README.md
  LICENSE
  .gitignore
  AGENTS.md
```

`builders/` 是目录：六种构建器各有各的解析逻辑，彼此没有交集，加第七种只加一个文件。
`main.ts` 保持单文件：执行层是整块抄来的，拆开要处理抄来代码之间的引用。

模块解析已核实（`internal/plugin/runtime.go:140`）：`./builders` → `builders/index.ts` 成立，
且不能跑出插件目录。

---

## 五、检测流程：默认路径零宽 glob

### 5.1 阶段 A：根级探测（首屏）

对固定的 13 个标记文件逐个 `workspace.stat(root + "/" + 标记)`。

**这不是「因为 stat 快」才这么做**，而是因为：stat 是常数次调用，不随项目规模增长；
而 `findFiles` 的主线程匹配成本随索引文件数线性增长（20 万文件时单条窄 glob 约 50ms，
13 条宽 glob 约 850ms，200 万文件时放大 10 倍）。

**为什么 13 次顺序 stat 可接受，而 13 条 glob 不可接受**：stat 是 k 次 RTT，
k=13 是常数，与项目规模无关；glob 是主线程上的 O(索引大小)，与项目规模线性相关。
前者最坏情况是慢，后者最坏情况是卡死界面。

第一阶段**不读文件内容**，只拿「有哪些构建器」。

### 5.2 阶段 B：按构建器读取

只对存在的构建器读它的根文件，每个构建器有**硬上限**：

| 构建器 | 读什么 | 文件数上限 |
|---|---|---|
| Cargo | `Cargo.toml` | 1 |
| Make | `Makefile` | 1 |
| Swift | `Package.swift` | 1 |
| CMake | `CMakeLists.txt` + `add_subdirectory` 跟随 | 1 + 6 |
| Meson | `meson.build` + `subdir()` 跟随 | 1 + 6 |
| Xcode | 不进默认路径 | 0 |

**全局文件访问预算：默认路径 ≤ 16 次**（13 次 stat + 按优先级分配的读取）。
超预算的构建器只列根文件里的 target，并在面板标「未完整列出」。

CMake 与 Meson 的 subdir 跟随**共用同一份 6 次预算**，按优先级（6.7）分配。

### 5.3 阶段 C：工具内省（后台，可选）

一律 `await process.run(...)`，显式传 timeout（默认 15s）。

### 5.4 关于 `findFiles`

**默认路径不调用。** 它只在两个地方出现：

1. 用户点「精确内省」时（Xcode 找 `*.xcodeproj`）
2. 用户点「重新扫描」且明确要求完整扫描时

即便调用，也**一次只发一条窄 glob**，不发 13 条宽 glob。

### 5.5 执行顺序与渲染时机

```
1. 根探测（阶段 A）—— 第一个 stat 回来就开始画骨架
2. 按优先级逐构建器读根文件（阶段 B）—— 每读完一个就追加到面板
3. 后台工具内省（阶段 C）—— 完成后原地替换推测项
4. 用户配置覆盖一切
```

**瀑布式渲染，不攒批**：用户看到的第一个画面与「总共有多少构建器」无关。

---

## 六、六种构建器

### 6.1 Cargo

| 档 | 做法 | 写盘 |
|---|---|---|
| 1 | 根 `Cargo.toml`：`[workspace] members`，或 `[[bin]] name` | 否 |
| 2 | `cargo metadata --no-deps --offline --format-version 1` | 否（已核实不写 Cargo.lock） |

`--offline` 已核实可用且不联网。

已验证两种形态：
- `glim`：纯 workspace，`workspace_members` 给 3 个 crate
- `Gmark`：根既是 `[package]` 又是 `[workspace]`，18 个 crate、3 个 `[[bin]]`

**生成规则**（只生成实际存在的）：

| 任务 | 命令 | 组 |
|---|---|---|
| build | `cargo build` | `{kind:"build", isDefault:true}` |
| build <member> | `cargo build -p <name>` | build |
| test | `cargo test` | test |
| clean | `cargo clean` | — |
| run <bin> | `cargo run --bin <name>` | — |

`kind` 只取 `bin`。`bench`/`custom-build`/`test` 目标不进任务列表
（Gmark 有 20+ 个 bench，会淹掉面板）。

**matcher 关键**：生成的 cargo 任务**一律带 `--message-format=short`**。
已核实：`cargo build --message-format=short` 输出
`src/main.rs:1:26: error[E0308]: mismatched types` —— 单行，
现有 `problemFrom()` 不需要任何改动即可匹配。
不带该参数时 rustc 输出两行结构（`error[E0308]` 换行 ` --> path:line:col`），
逐行引擎匹配不到。这是本插件选择 `--message-format=short` 的**唯一理由**。

### 6.2 CMake

| 档 | 做法 | 写盘 |
|---|---|---|
| 1 | 静态解析 `CMakeLists.txt`：`add_(executable\|library\|custom_target)`，跨行；跟 `add_subdirectory`（深度 ≤2，文件 ≤6） | 否 |
| 2 | CMake File API：读 `<build>/.cmake/api/v1/reply/` | 仅在已配置目录重配置时 |
| 3 | `cmake --preset` | 视档 2 |

**档 1 必须顺带做可配置性诊断**（CMake 独有）：

- `add_subdirectory(p)` 但 `p/CMakeLists.txt` 不存在 → 标「子模块未初始化」
- `cmake_minimum_required` 版本 < 3.5 且本机 cmake ≥ 4 → 标「需要 policy 覆盖」

这两条让用户在点构建**之前**就知道会失败。

**档 2 的协议约束（全部实测确认）**：

- 查询文件必须在**配置之前**存在：`<build>/.cmake/api/v1/query/codemodel-v2`
- 回复在 `<build>/.cmake/api/v1/reply/`：`index-*.json` → `codemodel-v2-*.json` → 每个 `target-*.json`
- `target-*.json` 的 `type` 给 `EXECUTABLE` / `STATIC_LIBRARY` / `SHARED_LIBRARY` / `UTILITY` 等
- Ninja 与 Unix Makefiles **两种生成器都支持**
- 写 query 用一次 `workspace.writeFile` 即可（`vfs.WriteFile` 会 `MkdirAll` 父目录）

流程：

```
有 build/CMakeCache.txt ？
  ├─ 无 → 不配置，只出档 1 任务
  └─ 有 → 读 CMAKE_HOME_DIRECTORY 与项目根比对
           ├─ 不匹配 → 不是本项目的构建目录，忽略
           ├─ 匹配、reply 已在 → 直接读
           └─ 匹配、reply 不在 → 写 query → 重新配置 → 读
```

`CMAKE_HOME_DIRECTORY` 是关键校验：没有它，残留的 build 目录会让面板列出**别的项目**的 target。

**判断「真的配置成功」不能只看 cache 存在**：实测失败的配置会留下 `CMakeCache.txt`
且 `CMAKE_HOME_DIRECTORY` 已写入。要看 `<build>/build.ninja` 或 `<build>/Makefile` 是否存在。

**目标过滤（必须，实测 libhttp 76 → 6）**：

| 类型 | 处理 |
|---|---|
| `EXECUTABLE` | 保留 |
| `STATIC_LIBRARY` / `SHARED_LIBRARY` / `MODULE_LIBRARY` / `OBJECT_LIBRARY` | 保留 |
| `INTERFACE_LIBRARY` | 丢弃（没有东西可构建） |
| `UTILITY` | **全部丢弃** |

libhttp 配好 libuv 后报 76 个 target，其中 72 个是 `UTILITY`（CTest 钩子 + 56 个 clang-tidy 子目标）。
`UTILITY` 里的 `clean`/`install` 由固定任务覆盖，不需要逐个列。

**任务集**：

| 任务 | 命令 | 组 |
|---|---|---|
| configure | `cmake -S . -B build` | — |
| build | shell：`if [ -f build/CMakeCache.txt ]; then cmake --build build; else cmake -S . -B build && cmake --build build; fi` | `{kind:"build", isDefault:true}` |
| build <target> | `cmake --build build --target <t>` | build |
| test | `ctest --test-dir build --output-on-failure` | test |
| clean | `cmake --build build --target clean` | — |
| install | `cmake --install build` | — |

**生成器不写死**：一律用 `cmake --build`，生成器无关。
不强制 `-G Ninja`，因为用户机器上不一定有 ninja。

**首次构建才配置**，扫描期绝不产生 build 目录（与 Meson 同形状）。

**policy 覆盖**：默认 `auto`——检测到 `cmake_minimum_required < 3.5` 且本机 cmake ≥ 4 时，
自动加 `-DCMAKE_POLICY_VERSION_MINIMUM=3.5`，并在任务 `detail` 里写明，**不静默**。
配置项 `cmake.policyMin` 可设 `off` 关掉。

**matcher**：编译错误实测为 `/path/file.cpp:1:17: error: ...`，与 GCC/Clang 同一条，直接复用。
配置错误是两行结构（`CMake Error at CMakeLists.txt:3 (...):` 消息在下一行），
逐行引擎表达不了，**原样留在日志里，不进问题面板**，写进 README 已知限制。

### 6.3 Meson

| 档 | 做法 | 写盘 |
|---|---|---|
| 1 | 读 `meson.build` + 跟 `subdir()`，文本匹配 `executable(`/`library(`，**回溯变量** | 否 |
| 1.5 | 根 `meson introspect --ast meson.build` 拿 `project()` 名字/版本 | 否 |
| 2 | `meson setup build` + `meson introspect --targets build` | 是 |

已核实：
- `--ast` **只认根文件**（`src/meson.build` 报 `Not the project root`）
- `--targets` **必须有 build 目录**
- `--ast` 返回的 `lines[0].name === "project"`，`args.positional[0].value` 是项目名

g4music 的真实形态必须处理：

```meson
c_name = meson.project_name()      # 名字是 meson 内建函数，不是字面量
executable(c_name, sources, ...)
```

**变量回溯必须识别 `meson.project_name()` / `meson.project_version()`**，
不能只处理 `c_name = 'g4music'`。回溯策略：单文件符号表，最多 3 跳；
遇到列表拼接/复杂函数调用就退回**目录名**作 target 名并标「推测」。

**档 2 必须按 `type` 过滤**：g4music setup 后报 44 个目标，
只有 1 个是 `executable`（`g4music`），其余是 `custom`/`run`/`alias`（38 个翻译文件）。
不过滤会淹没面板。

**任务集**：

| 任务 | 命令 | 说明 |
|---|---|---|
| build | shell：`if [ -f build/build.ninja ]; then meson compile -C build; else meson setup build && meson compile -C build; fi` | 首次自动 setup，非破坏性 |
| setup | `meson setup build` | 首次才有；之后变更走 `--reconfigure` |
| test | `meson test -C build` | — |
| clean | `meson setup --wipe build` | — |

扫描期绝不写磁盘；只有点 build 或点「精确内省」才 `meson setup`。

### 6.4 Swift

| 档 | 做法 | 说明 |
|---|---|---|
| 1 | 正则 `Package.swift` 的 `.executable(name:` / `.library(name:` | **主路径** |
| 2 | `swift package describe --type json` | 补充，失败静默 |

core-eq 静态解析已实测成功：`.executable(name: "CoreEQ"`。

**档 2 在本机不可用**：沙箱挡住 `~/Library/org.swift.swiftpm` 与 clang ModuleCache，
`describe` 直接 `Invalid manifest` 退出。这说明档 2 是**不可靠的加分项**，不是基线——
静态解析必须在没有工具、没有缓存、只读 home 的机器上也能出任务。

**任务集**：

| 任务 | 命令 |
|---|---|
| build | `swift build`（`isDefault`） |
| build <product> | `swift build --product <name>` |
| test | `swift test` |
| clean | `swift package clean` |
| run <product> | `swift run <name>` |

### 6.5 Make

| 档 | 做法 |
|---|---|
| 1 | 静态读 `.PHONY` 行 + `^[a-zA-Z0-9_][\w.-]*:` 目标 |
| 2 | `make -qp`（**exit 1 是正常的**） |

静态解析在 core-eq 上已精确：正则拿到 12 个目标，`.PHONY` 行拿到同样 12 个。
`make -qp` 用来补 `include` 引入的目标。

**已核实的过滤规则**：`make -qp` 输出去掉 `.` 开头和 `Makefile` 后，正好是 12 个真目标。
`-qp` 不创建任何文件（前后 `ls` 无差异）。只看 stdout，不看 exit code。

**配方原文可用**：输出里含 `xcodebuild ... build`，据此判断「Make 包了别的构建器」。

**任务生成**：每个目标一条 `make <target>`（`type: "process"`, `command: "make"`）。
分组按名字：

- `build`/`sign`/`install`/`release`/`dist` → build 组，`build` 若存在则 `isDefault`
- `test`/`*-test`/`check` → test 组
- 其余（`format`/`lint`/`clean`/…）→ 无组

### 6.6 Xcode

只有档 2：`xcodebuild -list -json -project X.xcodeproj`。

已核实返回 `{"project":{configurations,name,schemes,targets}}`。

**只有当没有 Makefile 包住它时才生成任务**：

```
xcodebuild -project CoreEQ.xcodeproj -scheme CoreEQ -configuration Debug build
```

core-eq 的 `Makefile:29` 就是 `xcodebuild ... build`，
所以这里不重复生成，只在面板上给 Make 的 `build` 打 `detail: "make → xcodebuild"`。

Xcode 是唯一需要 `*.xcodeproj` glob 的构建器，且只在「精确内省」时调用。

### 6.7 多构建器优先级

决定「默认构建」给谁。高 → 低：

1. `.mayoi/builders.json` 的 `prefer`
2. **Make 的配方里调用了别的构建器**（`make -qp` 输出含 `xcodebuild`/`swift build`/`cargo`/`cmake`/`meson`）
3. 有构建产物目录（`target/` `build/` `.build/` `dist/`）——**弱信号**：
   glim 无 `target/`、g4music 无 `build/`、core-eq 只有 `.build/`，单凭它猜不准
4. 固定次序：Cargo > CMake > Meson > Swift > Make > Xcode > Go > npm
5. 同名任务去重，先到先得

`isDefault` 只在**最终排第一的那个 build 任务**上置位；其余 build 任务保留
`group: "build"` 但无 `isDefault`。

core-eq 验证目标：`Package.swift` + `Makefile` + `CoreEQ.xcodeproj` 三者共存，
`Makefile:29` 调 `xcodebuild` → **Make 排第一，默认构建是 Make 的 build**。

---

## 七、问题匹配器

`problemFrom()` 原样复用，**逐行匹配够用**：

| 构建器 | matcher |
|---|---|
| Rust | `^(.+?):(\d+):(\d+): (error\|warning)(\[[A-Z]\d+\])?: (.+)$`（依赖 `--message-format=short`） |
| GCC/Clang/Swift | 同上 |
| Go | `^(.+?):(\d+):(\d+): (.+)$`，severity 固定 error（实测 Go 输出无 severity 字样） |
| Make | 复用 GCC/Clang |
| Meson | 复用 GCC/Clang |
| CMake | 编译错误复用 GCC/Clang；配置错误不进面板（见 6.2） |

---

## 八、面板

沿用 tasks 的 `stack + tree + code`，改动只在分组：

```
▾ Builders                          [刷新]
  ▾ CMake · libhttp
      build                  ✓       [执行]
      build client
      test
  ▾ Meson · g4music
      build g4music
─────────────────────────────────
  build                      ✓ 0     [日志] [清除]
  $ cmake --build build
  …最后 200 行
```

对齐 DESIGN.md 的 Stability：

- 构建器节点 `open: true`，折叠状态由 view 自己保持
- 行尾只放**一个**标记：`✓` / `✗ <code>` / `…`（运行中）。**时间不显示**（位数会变宽）
- 行内 `actions` 只在悬停显示（`pluginviews.go:592`），且白名单无 `play`
  —— 运行按钮用 `icon: "check"` 或文字按钮
- `button` 节点忽略 icon、无 disabled（`pluginviews.go:423-434`），「精确内省」用文字按钮
- 后台内省进行中：构建器节点 `description: "…"`，**不新增行**，避免行数跳动

---

## 九、执行层移植映射

见第二章表格。要点：

**必须原样保留的行为**：

1. `runTaskNow()` 的 `asShell` 判定（tasks `main.ts:539`）：
   `type: "shell"` 或带 `options.env` 时走 `sh -c`。
   **CMake 和 Meson 的 build 任务必须用 `shell`**（命令里含 `if`/`&&`）。
2. `startLive()` 的后台 shell + 日志轮询 + code 文件机制
3. 本地 250ms / 远程 800ms 的轮询间隔（`streamEvery`）
4. `diagnose()` 的「清上一轮问题」逻辑

**必须改的**：

1. `renderList()`：按构建器分组，且**绝不触发重新发现**（发现结果只缓存，`renderList` 只读缓存）
   —— 否则运行日志每 250ms 轮询一次就会重建一次发现
2. `Task` 加 `builder?: BuilderId`
3. 命令面收缩为：`builder.run` / `builder.build` / `builder.rerunLast` / `builder.reload` / `builder.showList`

**必须删除的**：`markRows` / `renderDebug` / `startDebug` / 所有 `tasks.debug*` 命令与断点逻辑。

---

## 十、配置 `.mayoi/builders.json`

```jsonc
{
  "disable": ["make"],                 // 关掉某个构建器
  "prefer": "cmake",                   // 默认构建给谁
  "extra": [                           // 手工补充
    { "label": "Release", "builder": "swift", "args": ["-c", "release"] }
  ],
  "timeout": 15000,                    // 单次工具内省超时（ms），默认 15000
  "cmake": {
    "policyMin": "auto",               // auto | off | "3.5"
    "buildDir": "build"                // 构建目录名，默认 build
  }
}
```

优先级：`prefer` > 手工 `extra` > 自动发现。同名 label 去重。

---

## 十一、刷新、缓存与并发

### 11.1 触发时机

| 事件 | 动作 |
|---|---|
| 打开文件夹（`workspace.changed`） | 清空 → 阶段 A/B 立即 → 阶段 C 后台 |
| 保存构建文件（`editor.didSave`） | 该构建器重新内省 |
| 点「重新扫描」 | 全部重来（仍遵守预算） |
| 点某构建器「精确内省」 | 只跑该构建器的档 2（CMake/Meson 可能写 build 目录） |

### 11.2 缓存

按 `标记文件绝对路径 → { mtime, tasks }`，`workspace.stat()` 拿 mtime。

### 11.3 并发控制（三条硬规则）

1. **单飞**：同一时刻最多一个发现进行中。三个入口（视图 `onShow`、文件保存、工作区切换）
   都可能并发触发。
2. **代次号**：自增 `generation`，回写前比对，旧的一轮结果直接丢弃，
   避免后到的旧结果覆盖新结果。
3. **progress 标题带代次号**：`window.progress` 用标题字符串做标识（`pluginapi.go:501`），
   同标题并发会互相删错。标题格式 `Scanning builders (gen N)`。

### 11.4 JS 事件循环预算

`BusyLimit = 10s` 测的是「JS 连续运行不中断」（`runtime.go:307,64`）。
解析循环里每处理若干文件 `await` 一次让出。
`await process.run` 算中断，所以 cmake/meson 的秒级配置不会触发。

---

## 十二、实施阶段

| 阶段 | 内容 | 验收（可执行） |
|---|---|---|
| 0 | 执行层移植 + `Builder` 接口 + 空面板 | `mayoi plugin dev .` 后侧栏出现 **Builders**，空态有「重新扫描」 |
| 1 | **Meson** | 打开 `g4music` 列出 `build g4music`；点 build 跑通 setup+compile；扫描期不产生 `build/` |
| 2 | **Cargo** | `glim` 列 3 成员；`Gmark` 列 3 bin；build 后错误进问题面板 |
| 3 | **Make** | `core-eq` 列 12 个目标，`build` 是默认 |
| 4 | **CMake** | `libhttp` 列 6 个真实目标（过滤掉 72 个 UTILITY）；libuv 为空时提前报「子模块未初始化」；`cmake_minimum_required 3.0` 时自动加 policy 覆盖并能构建成功 |
| 5 | **Swift** | `core-eq` 列出 `build CoreEQ`（静态解析，无需 swift 可用） |
| 6 | 优先级 | `core-eq` 默认构建选中 **Make 的 build** |
| 7 | Xcode 档 2 + 配置 + README | `core-eq` 在 Make 之外有 xcode 方案；`builders.json` 的 `disable`/`prefer` 生效 |

每阶段用 `mayoi run builder.reload` 验证，不重启。

---

## 十三、验证项目

| 构建器 | 项目 | 特征 |
|---|---|---|
| Cargo | `glim`（workspace，3 成员）、`Gmark`（18 crate，3 bin） | 两种形态都覆盖 |
| Make | `core-eq` | 12 个 target，含 `sign: build` 依赖 |
| Swift | `core-eq` | 1 个 executable product |
| Meson | `g4music` | target 在子目录，变量来自 `meson.project_name()` |
| **CMake** | **`libhttp`** | **多行 add_executable、空 submodule、过低 cmake_minimum_required、76→6 目标过滤** |
| 多构建器 | `core-eq` | Make + Swift + Xcode 共存，验证优先级 |

---

## 十四、风险

| 风险 | 应对 |
|---|---|
| **Swift 档 2 不可靠** | 静态解析为基线，档 2 失败静默 |
| **CMake 老项目拒绝配置** | 自动加 policy 覆盖并明示，不静默 |
| **CMake 子模块未初始化** | 扫描期就报，不等到构建失败 |
| **CMake UTILITY 目标洪水** | 按 `type` 过滤，不按名字猜 |
| **CMake build 目录属于别的项目** | `CMAKE_HOME_DIRECTORY` 校验 |
| **CMake 配置失败留下半个 cache** | 用 `build.ninja`/`Makefile` 判断是否真配置成功 |
| **CMake 配置错误不进问题面板** | 已知限制，写进 README |
| **Meson 变量是内建函数** | 符号表识别 `project_name()` |
| **Meson 档 2 目标洪水** | 按 `type == "executable"` 过滤 |
| **Rust 两行格式** | 生成的 cargo 任务带 `--message-format=short`；用户自带任务不带则该限制记入 README |
| **索引未就绪** | 默认路径不依赖 `findFiles` |
| **执行层两处漂移** | `// ported from mayoi-tasks` 标记，移植块集中 |
| **远端文件夹 RTT 放大** | 默认路径调用次数封顶，不随项目规模增长 |

---

## 十五、与原 BUILDERS-PLAN 的差异汇总

| 原方案 | 本方案 | 理由 |
|---|---|---|
| 方案 B（并入 tasks） | 方案 A（独立插件） | 用户定；两者不同时安装，不存在两个面板 |
| 4 种构建器 | 6 种（加 CMake、Xcode） | 用户要求 |
| Rust 需跨行延迟匹配约 30 行 | 不需要，用 `--message-format=short` | 实测单行 |
| Swift 静态解析「够用」、档 2 是主力 | 静态解析是**基线**，档 2 只是加分 | 档 2 在受限环境直接失败 |
| 扫目录树发现 | 根 stat 探测 + 显式路径跟随 | 插件 API 无 readdir |
| 一次 `findFiles` 拿全 | 默认路径**零宽 glob** | `findFiles` 匹配在主线程，成本随索引线性增长 |
| 按本机耗时决定同步/异步 | 调用次数、线程归属、数据规模 | 本机数字不可外推 |
| 未提 CMake | 完整三档 + 目标过滤 + 可配置性诊断 | 用户要求，libhttp 实测 |
