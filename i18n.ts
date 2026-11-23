// What this plugin says in the language Mayoi shows, which its own
// settings name: the editor's locale, or English where it is left to the
// system and cannot be read.
import { settings } from "mayoi";

type Table = { [key: string]: string };

// en is the words themselves, and the fallback of any key another
// language leaves out.
const en: Table = {
  "builder.title": "Builders",
  "builder.noBuilders": "No build system found",
  "builder.noBuildersHint": "Cargo.toml, CMakeLists.txt, meson.build, Package.swift and Makefile are looked for",
  "builder.reload": "Scan Again",
  "builder.inspect": "Inspect",
  "builder.inspecting": "Inspecting",
  "builder.scanning": "Scanning",
  "builder.running": "Running",
  "builder.runOne": "Run",
  "builder.commandLine": "command line",
  "builder.closeCommand": "Hide the command",
  "builder.log": "log",
  "builder.openLog": "Full Log",
  "builder.clearLog": "Clear Log",
  "builder.runningMark": "…",
  "builder.noTask": "No build task",
  "builder.guess": "guess",
  "builder.truncated": "not listed fully",
  "builder.initialised": "submodule not set up",
  "builder.oldPolicy": "old CMake policy",
  "builder.broken": "cannot be read",
  "builder.quiet": "the command printed nothing, and finished",
  "builder.missingSdk": "not set up, so a build cannot run",
  "builder.problems": "problems",
  "builder.defaultBuild": "default",
};

const zhHans: Table = {
  "builder.title": "构建器",
  "builder.noBuilders": "未发现构建系统",
  "builder.noBuildersHint": "会查找 Cargo.toml、CMakeLists.txt、meson.build、Package.swift 与 Makefile",
  "builder.reload": "重新扫描",
  "builder.inspect": "精确内省",
  "builder.inspecting": "正在内省",
  "builder.scanning": "正在扫描",
  "builder.running": "正在运行",
  "builder.runOne": "执行",
  "builder.commandLine": "命令行",
  "builder.closeCommand": "隐藏命令行",
  "builder.log": "日志",
  "builder.openLog": "完整日志",
  "builder.clearLog": "清除日志",
  "builder.runningMark": "…",
  "builder.noTask": "没有构建任务",
  "builder.guess": "推测",
  "builder.truncated": "未完整列出",
  "builder.initialised": "子模块未初始化",
  "builder.oldPolicy": "旧版 CMake 策略",
  "builder.broken": "无法读取",
  "builder.quiet": "命令没有输出，已结束",
  "builder.missingSdk": "未配置，无法构建",
  "builder.problems": "个问题",
  "builder.defaultBuild": "默认",
};

const ja: Table = {
  "builder.title": "ビルダー",
  "builder.noBuilders": "ビルドシステムが見つかりません",
  "builder.noBuildersHint": "Cargo.toml、CMakeLists.txt、meson.build、Package.swift、Makefile を探します",
  "builder.reload": "再スキャン",
  "builder.inspect": "詳細調査",
  "builder.inspecting": "調査中",
  "builder.scanning": "スキャン中",
  "builder.running": "実行中",
  "builder.runOne": "実行",
  "builder.commandLine": "コマンド行",
  "builder.closeCommand": "コマンド行を隠す",
  "builder.log": "ログ",
  "builder.openLog": "全体ログ",
  "builder.clearLog": "ログを消去",
  "builder.runningMark": "…",
  "builder.noTask": "ビルドタスクがありません",
  "builder.guess": "推測",
  "builder.truncated": "一部のみ",
  "builder.initialised": "サブモジュール未初期化",
  "builder.oldPolicy": "旧 CMake ポリシー",
  "builder.broken": "読み取れません",
  "builder.quiet": "出力なしで終了しました",
  "builder.missingSdk": "未設定のためビルドできません",
  "builder.problems": "件の問題",
  "builder.defaultBuild": "既定",
};

const tables: { [tag: string]: Table } = {
  en,
  "zh-Hans": zhHans,
  zh: zhHans,
  ja,
};

// tag is the language Mayoi shows: its locale setting when one is set,
// else the machine's, which is what a setting left empty follows. The
// runtime has no navigator, so the locale Intl resolves is what says it.
function tag(): string {
  try {
    const seen = settings.mayoi<string>("locale");
    if (seen) return seen;
  } catch {
    // A setting the plugin cannot read is no language at all.
  }
  try {
    const seen = Intl.DateTimeFormat().resolvedOptions().locale;
    if (seen) return seen;
  } catch {
    // A runtime without Intl names no language.
  }
  return "en";
}

// t is the word of a key in the language Mayoi shows.
export function t(key: string): string {
  const full = tag();
  const table = tables[full] || tables[full.split("-")[0]] || en;
  return table[key] || en[key] || key;
}
