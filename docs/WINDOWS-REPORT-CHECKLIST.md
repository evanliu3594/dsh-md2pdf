# Windows v2 验证汇报清单

本清单给 Windows 上的 DSH 会话执行。所有结果写实际输出；未执行的项写「未验证」并说明原因。不要修改 Mac 上的文件。

## 约束

- 只在 Windows 机器操作。
- 每条结果附命令、原始输出或返回 JSON。
- 时间用绝对时间，带时区。
- 失败最多重试两次；两次失败后记录原始错误，不再猜测。
- 不编造页数、字体、错误码或视觉结论。

## 1. 环境

假设仓库在 `D:\Liu\Desktop\test-md2pdf\dsh-md2pdf-win`。路径不同时替换。

```powershell
cd D:\Liu\Desktop\test-md2pdf\dsh-md2pdf-win
Get-ComputerInfo | Select-Object WindowsProductName,WindowsVersion,OsArchitecture
node -v
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Raw
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Raw
```

记录：Windows 版本与架构、DSH 版本、仓库绝对路径、profile 中 `dsh-md2pdf` 的依赖值与 `dsh.profile.bundles`、`printEngine` 的值、Node 路径与版本。

如果 profile 没有链接插件，停止 DSH 导出，汇报 blocker，不要继续调用 `md2pdf_export`。

## 2. 自动检查

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows-check.ps1
```

汇报：13 套断言的 N/N 与失败行、`list-audit` 原文、`profile-link`/`profile-bundle`/`print-engine`/`browser-fallback`/`file-lock` 的状态、任何 FAIL 或 SKIP 的原文。

Windows 账户没有创建符号链接的权限时，`export-check` 为 136/136，而不是 macOS 的 139/139；少掉的 3 条是 symlink 目标拒绝、目标文件保留、资源 symlink 警告。其余 12 套计数与 macOS 相同。

## 3. DSH 导出

清单文件：`%USERPROFILE%\md2pdf-win-check\DSH-PROMPT.txt`。

按文件逐个调用 `md2pdf_export`。每次记录：

| 用例 | 源文件 | ok | engine | generator | bytes | durationMs | pdfPath | 错误 |
|---|---|---|---|---|---|---|---|---|
| gongwen | | | | | | | | |
| numbers | | | | | | | | |
| header | | | | | | | | |
| footer | | | | | | | | |
| toc | | | | | | | | |
| paper | | | | | | | | |
| pagebreak | | | | | | | | |

期望 `engine` 为 `dsh`。若为 `browser`，记录实际值并停止其余 DSH 导出。

测试打印由用户在设置页点「测试打印」。记录是否显示引擎与路径，以及 `%USERPROFILE%\.dsh\md2pdf\test-print\test-print.pdf` 的字节与页数。

## 4. PDF 事实

对每个 PDF 运行：

```powershell
node scripts\pdf-info.mjs "<pdf 绝对路径>"
```

再运行大纲与链接检查：

```powershell
node -e "const fs=require('fs');const t=fs.readFileSync(process.argv[1],'latin1');console.log(JSON.stringify({outline:t.includes('/Outlines'),links:(t.match(/\/Subtype\s*\/Link/g)||[]).length,dests:(t.match(/\/Dest\s*\[/g)||[]).length}))" "<pdf 绝对路径>"
```

期望：

- gongwen：pages=4，页面 594.96x841.92，outline=true，fonts 含 FangSong、KaiTi、SimSun 中至少两个。
- numbers：pages>=1，页脚页码需视觉确认。
- header：pages>=1，页眉文字需视觉确认。
- footer：pages>=1，页脚文字需视觉确认。
- toc：pages=2，links>=3，目录单独一页。

本夹具只有 `# Chapter One`、`## Section One`、`# Chapter Two` 三个标题，所以 links=3 与内容一致。目录链接的目标是具名 `/Dest /md2pdf-h-*`；上面的 `dests` 只统计数组形式，不能用它判断目录链接数量。
- paper：pages=1，题名块在首页。
- pagebreak：pages=2。
- test-print：pages=1，A4。

汇报每个文件的 pages、boxes、fonts、outline、links、dests。

## 5. 锁定目标

先导出 `lock.md`，生成 `lock.pdf`，记录 SHA256。

```powershell
$fixture = "$env:USERPROFILE\md2pdf-win-check\dsh-中文 path"
$pdf = Join-Path $fixture 'lock.pdf'
Get-FileHash -Algorithm SHA256 $pdf
$holdScript = Join-Path $env:TEMP 'hold-md2pdf.ps1'
Set-Content -LiteralPath $holdScript -Encoding UTF8 -Value @'
param([string]$Path)
$fs = [IO.File]::Open($Path,'Open','ReadWrite','None')
Start-Sleep 120
$fs.Close()
'@
$locker = Start-Process powershell -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "{0}" "{1}"' -f $holdScript, $pdf) -PassThru
$locker.Id
```

用独立 PowerShell 进程持锁，不要用 `Start-Job`；作业只存在于当前进程，下一条命令拿不到句柄。

如果 DSH agent 的终端只能写会话工作区，把 `lock.md` 复制到工作区内同名子目录再测；插件行为与目录无关。

持锁期间让 DSH 再导出 `lock.md`。记录返回 JSON 或错误码；期望 `file-busy`。再记录旧 PDF 的 SHA256 和目录里是否有 `*.md2pdf-*.pdf.tmp`。

停止任务：

```powershell
Stop-Process -Id $locker.Id
```

错误码是 `write-failed`、`state-conflict` 或其他值时，如实记录。

## 6. 视觉确认

这些项由用户看 PDF 后确认。agent 只记录用户答复，不自行判断。

- gongwen：页脚「第 N 页 / 共 4 页」居中；标题、字体、边距正常；PDF 查看器左侧有 9 条书签；页眉为空。
- numbers：页脚有页码；页眉为空。
- header：页眉文字距左边约 18 mm；页脚为空。
- footer：页脚文字居中；页眉为空。
- toc：目录单独一页；点击条目能跳到对应正文；目录内无页码。
- paper：题名、作者、单位、日期、Abstract、Keywords 在首页；无单独封面；英文标签。
- pagebreak：第二页内容另起一页。
- test print：设置页显示引擎与路径。

## 7. 汇报格式

按下面的结构回复：

```markdown
# Windows v2 验证报告

- 时间：
- 机器：
- Windows：
- DSH 版本：
- 仓库：
- profile：
- printEngine：
- Node：

## 结论

- 通过：
- 失败：
- 未验证：

## 自动检查

（贴 windows-check.ps1 的 Summary 表，失败行附原文）

## DSH 导出

（贴第 3 节表格与每次原始 JSON）

## PDF 事实

（贴每个文件的 pdf-info 与 outline/links JSON）

## 锁定目标

（贴两次哈希、错误码、临时文件列表）

## 视觉确认

（逐项写用户答复：通过 / 失败 / 未验证）

## 阻塞与原始错误

（没有就写「无」；有就贴完整错误与复现命令）
```
