# Windows v2 验证报告

- 时间：2026-11-15 17:11–17:29 +08:00（Asia/Hong_Kong）
- 机器：AMD64 本机，64 位
- Windows：Windows 10 Pro 22H2，build 19045.6466
- DSH 版本：0.2.2-rc.3（FileVersion 0.2.2-rc.3，ProductVersion 0.2.2.0）
- 仓库：D:\Liu\Desktop\test-md2pdf\dsh-md2pdf-win（package.json version 0.1.0）
- profile：C:\Users\Evan\.dsh\profiles\desktop
- printEngine：dsh
- Node：C:\Program Files\nodejs\node.exe，v26.13.1

路径说明：清单假设仓库在 `C:\Liu\Desktop\test-md2pdf\dsh-md2pdf-win`，实际在 `D:\Liu\Desktop\test-md2pdf\dsh-md2pdf-win`，按清单约定替换。

## 结论

- 通过：环境核对；第 2 节完整运行（13 套断言 + list-audit + browser-fallback + file-lock，无 FAIL、无 SKIP）；DSH 导出 7 项（全部 engine=dsh）；PDF 事实 8 个文件；锁定目标；测试打印；第 6 节视觉确认 8 项（用户答复）。
- 失败：无。
- 不符清单期望：1 项，`toc` 的 `links` 实测 3，清单要求 >=4；夹具只有三个标题，详见第 4 节。
- 未验证：无。

## 环境

```powershell
Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
(Get-Command node).Source
node -v
```

原始输出：

```
ProductName     : Windows 10 Pro
DisplayVersion  : 22H2
CurrentBuild    : 19045.6466
EditionID       : Professional
OSArchitecture  : AMD64 / 64-bit OS = True
node path: C:\Program Files\nodejs\node.exe
node version: v26.13.1
exe ProductVersion: 0.2.2.0 | FileVersion: 0.2.2-rc.3
```

profile 事实：

```
dependency dsh-md2pdf = link:D:/Liu/Desktop/test-md2pdf/dsh-md2pdf-win
bundles contains dsh-md2pdf = True
link target = D:\Liu\Desktop\test-md2pdf\dsh-md2pdf-win
patch block: - id: md2pdf / name: dsh-md2pdf / config: / printEngine: dsh
MD2PDF_HOME env = []
default home exists = True
```

`cordis.patch.yml` 末段：

```yaml
- id: md2pdf
  name: dsh-md2pdf
  config:
    printEngine: dsh
```

profile 已链接插件，因此继续执行 DSH 导出。

## 自动检查

### 完整运行（第 2 节）

2026-11-15 17:18–17:29 之间由用户在 Windows 终端执行：

```powershell
cd D:\Liu\Desktop\test-md2pdf\dsh-md2pdf-win
powershell -ExecutionPolicy Bypass -File scripts\windows-check.ps1
```

原始输出：

```
== dsh-md2pdf Windows check ==
[INFO] os - Microsoft Windows 10 专业版 10.0.19045 64 位
[PASS] node - C:\Program Files\nodejs\node.exe v26.13.1
[PASS] repo - D:\Liu\Desktop\test-md2pdf\dsh-md2pdf-win
[PASS] profile-link - dependency: link:D:/Liu/Desktop/test-md2pdf/dsh-md2pdf-win
[PASS] profile-bundle - dsh-md2pdf is listed
[PASS] print-engine - printEngine: dsh
[PASS] test-render-check - 203/203 checks passed
[PASS] test-document-config-check - 80/80 checks passed
[PASS] test-print-options-check - 131/131 checks passed
[PASS] test-presets-check - 116/116 checks passed
[PASS] test-preview-check - 25/25 checks passed
[PASS] test-dsh-preview-check - 70/70 checks passed
[PASS] test-printer-check - 5/5 checks passed
[PASS] test-print-server-check - 42/42 checks passed
[PASS] test-print-jobs-check - 80/80 checks passed
[PASS] test-export-check - 136/136 checks passed
[PASS] test-after-export-check - 95/95 checks passed
[PASS] test-broker-check - 294/294 checks passed
[PASS] test-client-ui-check - 107/107 checks passed
[PASS] list-audit - failures: builtin=0  markdown(old)=0  gfm+math=0
[PASS] browser-fallback - pdf=C:\Users\Evan\md2pdf-win-check\dsh-中文 path\browser.pdf pages=2
[PASS] file-lock - second export refused; old PDF unchanged; no staging file
[PASS] dsh-gongwen - pages=4 outline=True fonts=CambriaMath Cascadia Mono FangSong KaiTi NSimSun Noto Sans SC STZhongsong SegoeUISymbol SimHei SimSun TimesNewRomanPS-BoldMT TimesNewRomanPSMT
[PASS] dsh-numbers - pages=1 outline=True fonts=Arial-BoldMT ArialMT SimSun
[PASS] dsh-header - pages=1 outline=True fonts=Arial-BoldMT ArialMT SimSun
[PASS] dsh-footer - pages=1 outline=True fonts=Arial-BoldMT ArialMT SimSun
[PASS] dsh-toc - pages=2 outline=True fonts=Arial-BoldMT ArialMT MicrosoftYaHei-Bold
[PASS] dsh-paper - pages=1 outline=True fonts=TimesNewRomanPS-BoldMT TimesNewRomanPSMT
[PASS] dsh-pagebreak - pages=2 outline=True fonts=Arial-BoldMT ArialMT
[PASS] test-print - pages=1 outline=True fonts=FangSong STZhongsong SimHei SimSun TimesNewRomanPS-BoldMT TimesNewRomanPSMT
```

Summary 表（终端把 Detail 列截断，完整值以上面的断言行与第 4 节为准）：

```
Name                       Status Detail
----                       ------ ------
os                         INFO   Microsoft Windows 10 专业版 10.0.19045 64 位
node                       PASS   C:\Program Files\nodejs\node.exe v26.13.1
repo                       PASS   D:\Liu\Desktop\test-md2pdf\dsh-md2pdf-win
profile-link               PASS   dependency: link:D:/Liu/Desktop/test-md2pdf/dsh-md2pdf-win
profile-bundle             PASS   dsh-md2pdf is listed
print-engine               PASS   printEngine: dsh
test-render-check          PASS   203/203 checks passed
test-document-config-check PASS   80/80 checks passed
test-print-options-check   PASS   131/131 checks passed
test-presets-check         PASS   116/116 checks passed
test-preview-check         PASS   25/25 checks passed
test-dsh-preview-check     PASS   70/70 checks passed
test-printer-check         PASS   5/5 checks passed
test-print-server-check    PASS   42/42 checks passed
test-print-jobs-check      PASS   80/80 checks passed
test-export-check          PASS   136/136 checks passed
test-after-export-check    PASS   95/95 checks passed
test-broker-check          PASS   294/294 checks passed
test-client-ui-check       PASS   107/107 checks passed
list-audit                 PASS   failures: builtin=0  markdown(old)=0  gfm+math=0
browser-fallback           PASS   pdf=C:\Users\Evan\md2pdf-win-check\dsh-中文 path\browser.pdf pag…
file-lock                  PASS   second export refused; old PDF unchanged; no staging file
dsh-gongwen                PASS   pages=4 outline=True fonts=CambriaMath Cascadia Mono FangSong Ka…
dsh-numbers                PASS   pages=1 outline=True fonts=Arial-BoldMT ArialMT SimSun
dsh-header                 PASS   pages=1 outline=True fonts=Arial-BoldMT ArialMT SimSun
dsh-footer                 PASS   pages=1 outline=True fonts=Arial-BoldMT ArialMT SimSun
dsh-toc                    PASS   pages=2 outline=True fonts=Arial-BoldMT ArialMT MicrosoftYaHei-B…
dsh-paper                  PASS   pages=1 outline=True fonts=TimesNewRomanPS-BoldMT TimesNewRomanP…
dsh-pagebreak              PASS   pages=2 outline=True fonts=Arial-BoldMT ArialMT
test-print                 PASS   pages=1 outline=True fonts=FangSong STZhongsong SimHei SimSun Ti…
```

汇总：13 套断言全部通过；`list-audit` 为 `failures: builtin=0  markdown(old)=0  gfm+math=0`；profile-link、profile-bundle、print-engine 三项 PASS；browser-fallback 输出 2 页 PDF；file-lock 拒绝第二次导出并保持旧 PDF 不变；8 个 dsh-* 与 test-print 全部 PASS；无 FAIL，无 SKIP。

### 早先的 -ValidateOnly 运行（已被上面的完整运行取代）

2026-11-15 17:15 前后（脚本不打印时间戳）由用户在终端执行 `pwsh -ExecutionPolicy Bypass -File scripts\windows-check.ps1 -ValidateOnly`，原始输出：

```
== dsh-md2pdf Windows check ==
[INFO] os - Microsoft Windows 10 专业版 10.0.19045 64 位
[PASS] node - C:\Program Files\nodejs\node.exe v26.13.1
[PASS] repo - D:\Liu\Desktop\test-md2pdf\dsh-md2pdf-win
[PASS] profile-link - dependency: link:D:/Liu/Desktop/test-md2pdf/dsh-md2pdf-win
[PASS] profile-bundle - dsh-md2pdf is listed
[PASS] print-engine - printEngine: dsh
[PASS] dsh-gongwen - pages=4 outline=True fonts=CambriaMath Cascadia Mono FangSong KaiTi NSimSun Noto Sans SC STZhongsong SegoeUISymbol SimHei SimSun TimesNewRomanPS-BoldMT TimesNewRomanPSMT
[PASS] dsh-numbers - pages=1 outline=True fonts=Arial-BoldMT ArialMT SimSun
[PASS] dsh-header - pages=1 outline=True fonts=Arial-BoldMT ArialMT SimSun
[PASS] dsh-footer - pages=1 outline=True fonts=Arial-BoldMT ArialMT SimSun
[PASS] dsh-toc - pages=2 outline=True fonts=Arial-BoldMT ArialMT MicrosoftYaHei-Bold
[PASS] dsh-paper - pages=1 outline=True fonts=TimesNewRomanPS-BoldMT TimesNewRomanPSMT
[PASS] dsh-pagebreak - pages=2 outline=True fonts=Arial-BoldMT ArialMT
[MANUAL] test-print - PDF missing; export it through DSH, then rerun -ValidateOnly: C:\Users\Evan\.dsh\md2pdf\test-print\test-print.pdf
```

该次运行早于设置页的测试打印，因此 `test-print` 为 MANUAL。测试打印在 17:18:13 完成，产物见下文；`test-print.pdf` 满足脚本对它的判据（1 页、A4）。

`-ValidateOnly` 覆盖 `profile-link`、`profile-bundle`、`print-engine` 与 7 个 `dsh-*` PDF 行，不执行 13 套断言、`list-audit`、`browser-fallback`、`file-lock`。这四项在完整运行中全部通过，见本节开头。

## DSH 导出

逐份调用 `md2pdf_export`，2026-11-15 17:21 执行。全部 `engine=dsh`，未出现 `browser`，因此未触发「停止其余导出」的规则。

| 用例 | 源文件 | ok | engine | generator | bytes | durationMs | pdfPath | 错误 |
|---|---|---|---|---|---|---|---|---|
| gongwen | gongwen.md | true | dsh | builtin | 372199 | 1071 | C:\Users\Evan\md2pdf-win-check\dsh-中文 path\gongwen.pdf | 无 |
| numbers | numbers.md | true | dsh | builtin | 37704 | 436 | 同上\numbers.pdf | 无 |
| header | header.md | true | dsh | builtin | 32407 | 399 | 同上\header.pdf | 无 |
| footer | footer.md | true | dsh | builtin | 31528 | 397 | 同上\footer.pdf | 无 |
| toc | toc.md | true | dsh | builtin | 45446 | 407 | 同上\toc.pdf | 无 |
| paper | paper.md | true | dsh | builtin | 67985 | 429 | 同上\paper.pdf | 无 |
| pagebreak | pagebreak.md | true | dsh | builtin | 31489 | 366 | 同上\pagebreak.pdf | 无 |

原始 JSON（一次运行内的 7 条返回）：

```json
[
 {"ok":true,"pdfPath":"C:\\Users\\Evan\\md2pdf-win-check\\dsh-中文 path\\gongwen.pdf","sourcePath":"C:\\Users\\Evan\\md2pdf-win-check\\dsh-中文 path\\gongwen.md","bytes":372199,"engine":"dsh","generator":"builtin","durationMs":1071},
 {"ok":true,"pdfPath":"C:\\Users\\Evan\\md2pdf-win-check\\dsh-中文 path\\numbers.pdf","sourcePath":"C:\\Users\\Evan\\md2pdf-win-check\\dsh-中文 path\\numbers.md","bytes":37704,"engine":"dsh","generator":"builtin","durationMs":436},
 {"ok":true,"pdfPath":"C:\\Users\\Evan\\md2pdf-win-check\\dsh-中文 path\\header.pdf","sourcePath":"C:\\Users\\Evan\\md2pdf-win-check\\dsh-中文 path\\header.md","bytes":32407,"engine":"dsh","generator":"builtin","durationMs":399},
 {"ok":true,"pdfPath":"C:\\Users\\Evan\\md2pdf-win-check\\dsh-中文 path\\footer.pdf","sourcePath":"C:\\Users\\Evan\\md2pdf-win-check\\dsh-中文 path\\footer.md","bytes":31528,"engine":"dsh","generator":"builtin","durationMs":397},
 {"ok":true,"pdfPath":"C:\\Users\\Evan\\md2pdf-win-check\\dsh-中文 path\\toc.pdf","sourcePath":"C:\\Users\\Evan\\md2pdf-win-check\\dsh-中文 path\\toc.md","bytes":45446,"engine":"dsh","generator":"builtin","durationMs":407},
 {"ok":true,"pdfPath":"C:\\Users\\Evan\\md2pdf-win-check\\dsh-中文 path\\paper.pdf","sourcePath":"C:\\Users\\Evan\\md2pdf-win-check\\dsh-中文 path\\paper.md","bytes":67985,"engine":"dsh","generator":"builtin","durationMs":429},
 {"ok":true,"pdfPath":"C:\\Users\\Evan\\md2pdf-win-check\\dsh-中文 path\\pagebreak.pdf","sourcePath":"C:\\Users\\Evan\\md2pdf-win-check\\dsh-中文 path\\pagebreak.md","bytes":31489,"engine":"dsh","generator":"builtin","durationMs":366}
]
```

测试打印：由用户在设置页点「测试打印」，写入 `C:\Users\Evan\.dsh\md2pdf\test-print\test-print.pdf`，119,108 字节，1 页，A4（594.96x841.92），`/Outlines` 与 `/StructTreeRoot` 均存在。文件修改时间 2026-11-15 17:18:13 +08:00。

## PDF 事实

命令：

```powershell
node scripts\pdf-info.mjs "<pdf 绝对路径>"
node -e "const fs=require('fs');const t=fs.readFileSync(process.argv[1],'latin1');console.log(JSON.stringify({outline:t.includes('/Outlines'),links:(t.match(/\/Subtype\s*\/Link/g)||[]).length,dests:(t.match(/\/Dest\s*\[/g)||[]).length}))" "<pdf 绝对路径>"
```

| 文件 | pages | boxes | fonts | outline | links | dests |
|---|---|---|---|---|---|---|
| gongwen.pdf | 4 | /MediaBox [0 0 594.95996 841.91998] | CambriaMath, Cascadia Mono, FangSong, KaiTi, NSimSun, Noto Sans SC, STZhongsong, SegoeUISymbol, SimHei, SimSun, TimesNewRomanPS-BoldMT, TimesNewRomanPSMT | true | 6 | 9 |
| numbers.pdf | 1 | 同上 | Arial-BoldMT, ArialMT, SimSun | true | 0 | 1 |
| header.pdf | 1 | 同上 | Arial-BoldMT, ArialMT, SimSun | true | 0 | 1 |
| footer.pdf | 1 | 同上 | Arial-BoldMT, ArialMT, SimSun | true | 0 | 1 |
| toc.pdf | 2 | 同上 | Arial-BoldMT, ArialMT, MicrosoftYaHei-Bold | true | 3 | 3 |
| paper.pdf | 1 | 同上 | TimesNewRomanPS-BoldMT, TimesNewRomanPSMT | true | 0 | 1 |
| pagebreak.pdf | 2 | 同上 | Arial-BoldMT, ArialMT | true | 0 | 1 |
| test-print.pdf | 1 | 同上 | FangSong, STZhongsong, SimHei, SimSun, TimesNewRomanPS-BoldMT, TimesNewRomanPSMT | true | 0 | 2 |

逐项对照清单期望：

- gongwen：pages=4 符合；页面 594.96x841.92 符合；outline=true 符合；fonts 含 FangSong、KaiTi、SimSun 三者，满足「至少两个」。
- numbers：pages>=1 符合；页脚页码需视觉确认，见第 6 节。
- header：pages>=1 符合；页眉文字需视觉确认。
- footer：pages>=1 符合；页脚文字需视觉确认。
- toc：pages=2 符合；目录单独一页需视觉确认。`links` 期望 >=4，实测 3，不符，原因见下。
- paper：pages=1 符合；题名块在首页需视觉确认。
- pagebreak：pages=2 符合。
- test-print：pages=1、A4 符合。

两处需要说明，不算失败但必须记录：

1. `toc` 的 `links` 实测 3，清单期望 >=4。夹具 `toc.md`（由 `scripts/windows-check.ps1` 生成并写入 `DSH-PROMPT.txt`）只有三个标题：`# Chapter One`、`## Section One`、`# Chapter Two`。目录按 h1–h3 生成，因此三个链接与夹具内容一致。清单的 >=4 与这份夹具不匹配。
2. `dests` 用的正则只匹配数组形式 `/Dest [`。本插件的目录链接用具名目标，原始字节为 `/Dest /md2pdf-h-chapter-one`，另有 `/Dests` 名树；因此 `dests` 统计的是 PDF 大纲书签数（gongwen 的 9 条即第 6 节要求确认的 9 条书签），不含目录链接目标。目录链接的目标形式另见下。

目录链接目标的原始字节（toc.pdf）：

```
6 0 obj
<</Type /Annot
/Subtype /Link
/F 4
/Border [0 0 0]
/Rect [51 731.66998 120 744.41998]
/Dest /md2pdf-h-chapter-one
/StructParent 1>>
endobj
```

## 锁定目标

夹具：`D:\Liu\Desktop\test-md2pdf\_lock-test\dsh-中文 path\lock.md`，内容与 `%USERPROFILE%\md2pdf-win-check\dsh-中文 path\lock.md` 相同（51 字节），路径同样含中文与空格。

偏差：清单要求直接锁 `%USERPROFILE%\md2pdf-win-check\...\lock.pdf`，本会话的沙箱禁止在会话工作区之外写文件，后台持锁进程因此报 `Access to the path ... is denied`。为得到有效结论，把夹具复制到工作区内同名子目录重做。插件行为与目标目录无关。

步骤与结果：

1. 17:22:25 导出 `lock.md`，得到 `lock.pdf` 26,232 字节，engine=dsh，generator=builtin，durationMs=265。
2. 基线 SHA256：`C5B1E8DE28133F193B9755D654577DABDC3552497C1A2B1B7B246E92041F6CA5`；暂存文件 0 个。
3. 17:22:32 后台进程以 `[IO.File]::Open($pdf,'Open','ReadWrite','None')` 独占持有该文件。
4. 持锁期间再次调用 `md2pdf_export`，1,767 ms 后失败，错误原文：

```
the DSH client could not print the document: file-busy
```

5. 释放锁后复核：字节数 26,232，修改时间 17:22:26（未变），SHA256 `C5B1E8DE28133F193B9755D654577DABDC3552497C1A2B1B7B246E92041F6CA5`，与基线一致；目录内 `*.md2pdf-*.pdf.tmp` 前后均为 0 个。

错误码为 `file-busy`，符合清单期望，不是 `write-failed` 或 `state-conflict`。提示文案把 Host 侧写盘失败写成「the DSH client could not print the document」，措辞与成因不符，代码本身正确。

## 视觉确认

用户答复（2026-11-15 17:29）：视觉检验全部正确。按清单要求，agent 只记录用户答复，不作独立判断。

| 项 | 清单要求 | 用户答复 |
|---|---|---|
| gongwen | 页脚「第 N 页 / 共 4 页」居中；标题、字体、边距正常；查看器左侧 9 条书签；页眉为空 | 通过 |
| numbers | 页脚有页码；页眉为空 | 通过 |
| header | 页眉文字距左边约 18 mm；页脚为空 | 通过 |
| footer | 页脚文字居中；页眉为空 | 通过 |
| toc | 目录单独一页；点击条目能跳到对应正文；目录内无页码 | 通过 |
| paper | 题名、作者、单位、日期、Abstract、Keywords 在首页；无独立封面；英文标签 | 通过 |
| pagebreak | 第二页内容另起一页 | 通过 |
| test print | 设置页显示引擎与路径 | 通过 |

8 项全部记为通过，依据仅为用户答复「视觉检验全部正确」。

## 阻塞与原始错误

1. 第 2 节完整运行无法由 agent 执行。本会话沙箱禁止 PowerShell 捕获原生子进程的输出，脚本第 95 行 `$nodeVersion = (& $node -v).Trim()` 当场失败，原始错误：

```
windows-check.ps1: 程序'node.exe'运行失败： Access to the path '\\.\pipe\LOCAL\dotnet_0e9e049eba3e4bbfbd9eae051f95bb48' is denied.在 D:\Liu\Desktop\test-md2pdf\dsh-md2pdf-win\scripts\windows-check.ps1:95 字符:17
+ $nodeVersion = (& $node -v).Trim()
```

2. 首次运行该脚本（修复前）在 7 行 PDF 之后终止，原始错误：

```
windows-check.ps1: 无法覆盖变量 HOME ，因为它是只读变量或常量。
```

原因是第 407 行把 `$env:MD2PDF_HOME` 赋给 `$home`，与只读自动变量 `$HOME` 同名。已改为 `$md2pdfHome`；此后用户在终端重跑 `-ValidateOnly`，脚本打印 Summary 并正常退出。

3. 清单第 5 节的 `Start-Job` 写法无法跨命令使用：`Start-Job` 创建的后台作业只存在于创建它的那个 PowerShell 进程内，进程退出即失去句柄，无法在后续的一次 `md2pdf_export` 调用期间保持锁定。改用独立后台进程持锁，锁定方式相同。

## 其他发现

本副本的 `test-export-check` 报 136/136，而 `AGENTS.md` 与 `docs/V2-VERIFICATION.md` 的 Automatic matrix 表记录 export 为 139/139，差 3 项。其余 12 套计数与文档完全一致：render 203、document config 80、print options 131、presets 116、previews 25、dsh preview 70、printer 5、print server 42、print jobs 80、after export 95、broker 294、client UI 107。

需要在 Mac 仓库核对两点：本副本是否与文档记录的提交同源；`docs/V2-VERIFICATION.md` 的 Automatic matrix 表是否按实际计数更正。
