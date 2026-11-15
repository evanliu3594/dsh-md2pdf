<#
  Windows check for the dsh-md2pdf v2 branch.

  It runs the automatic suites, creates fixtures under a path with Chinese
  characters and spaces, exercises the browser fallback and the target-file
  lock, and validates PDFs produced by DSH. It does not click the DSH UI or
  call the agent tool. The DSH client cases need a DSH session; the script
  writes DSH-PROMPT.txt with the export list.

  Run from the copied repo:
    powershell -ExecutionPolicy Bypass -File scripts\windows-check.ps1
  After the DSH exports:
    powershell -ExecutionPolicy Bypass -File scripts\windows-check.ps1 -ValidateOnly
#>
[CmdletBinding()]
param(
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
  [string]$WorkDir = (Join-Path $env:USERPROFILE 'md2pdf-win-check'),
  [string]$ProfilePath = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [string]$NodePath = '',
  [switch]$ValidateOnly,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$script:Results = New-Object System.Collections.ArrayList

function Add-Result {
  param([string]$Name, [string]$Status, [string]$Detail = '')
  [void]$script:Results.Add([pscustomobject]@{ Name = $Name; Status = $Status; Detail = $Detail })
  Write-Host ("[{0}] {1} - {2}" -f $Status, $Name, $Detail)
}

function Stop-Check {
  param([string]$Message)
  Write-Host ("FAIL: " + $Message) -ForegroundColor Red
  exit 1
}

function Write-Utf8 {
  param([string]$Path, [string]$Text)
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Find-Node {
  param([string]$Preferred)
  $candidates = New-Object System.Collections.ArrayList
  if ($Preferred) { [void]$candidates.Add($Preferred) }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { [void]$candidates.Add($command.Source) }
  $runtimeRoot = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path -LiteralPath $runtimeRoot) {
    Get-ChildItem -LiteralPath $runtimeRoot -Filter node.exe -Recurse -ErrorAction SilentlyContinue |
      ForEach-Object { [void]$candidates.Add($_.FullName) }
  }
  $installs = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness')
  )
  foreach ($install in $installs) {
    if (Test-Path -LiteralPath $install) {
      Get-ChildItem -LiteralPath $install -Filter node.exe -Recurse -ErrorAction SilentlyContinue |
        ForEach-Object { [void]$candidates.Add($_.FullName) }
    }
  }
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  return $null
}

function Get-PdfInfo {
  param([string]$Path, [string]$Node)
  $json = & $Node (Join-Path $repo 'scripts\pdf-info.mjs') $Path
  if ($LASTEXITCODE -ne 0) { return $null }
  return ($json | ConvertFrom-Json)
}

Write-Host '== dsh-md2pdf Windows check =='
$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
if ($os) { Add-Result 'os' 'INFO' ($os.Caption + ' ' + $os.Version + ' ' + $os.OSArchitecture) }
else { Add-Result 'os' 'INFO' ([Environment]::OSVersion.VersionString) }

$repo = (Resolve-Path -LiteralPath $RepoPath).Path
if (-not (Test-Path -LiteralPath (Join-Path $repo 'package.json'))) {
  Stop-Check ("not the plugin repo: " + $repo)
}
$node = Find-Node $NodePath
if (-not $node) { Stop-Check 'Node.js not found. Install Node 20+ or pass -NodePath.' }
$nodeVersion = (& $node -v).Trim()
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) {
  Stop-Check ("Node 20+ required, found " + $nodeVersion)
}
Add-Result 'node' 'PASS' ($node + ' ' + $nodeVersion)
Add-Result 'repo' 'PASS' $repo

if (-not (Test-Path -LiteralPath (Join-Path $repo 'node_modules\temml'))) {
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) { Stop-Check 'temml is missing and npm was not found. Install Node.js with npm or copy node_modules.' }
  Write-Host 'Installing temml...'
  & $npm.Source install --no-audit --no-fund --prefix $repo
  if ($LASTEXITCODE -ne 0) { Stop-Check 'npm install failed' }
}

$profilePackage = Join-Path $ProfilePath 'package.json'
if (Test-Path -LiteralPath $profilePackage) {
  $profile = Get-Content -LiteralPath $profilePackage -Raw | ConvertFrom-Json
  $dependency = $null
  if ($profile.PSObject.Properties.Name -contains 'dependencies') {
    $dependency = $profile.dependencies.'dsh-md2pdf'
  }
  $link = Join-Path $ProfilePath 'node_modules\dsh-md2pdf'
  if ($dependency -and (Test-Path -LiteralPath $link)) {
    Add-Result 'profile-link' 'PASS' ('dependency: ' + $dependency)
  } else {
    Add-Result 'profile-link' 'MANUAL' 'plugin is not linked; see the setup text below'
  }
  $bundles = @()
  if ($profile.dsh -and $profile.dsh.profile) { $bundles = @($profile.dsh.profile.bundles) }
  if ($bundles -contains 'dsh-md2pdf') { Add-Result 'profile-bundle' 'PASS' 'dsh-md2pdf is listed' }
  else { Add-Result 'profile-bundle' 'MANUAL' 'add dsh-md2pdf to dsh.profile.bundles' }
  $patch = Join-Path $ProfilePath 'cordis.patch.yml'
  if (Test-Path -LiteralPath $patch) {
    $patchText = Get-Content -LiteralPath $patch -Raw
    if ($patchText -match 'printEngine:\s*dsh') { Add-Result 'print-engine' 'PASS' 'printEngine: dsh' }
    elseif ($patchText -match 'printEngine:\s*browser') { Add-Result 'print-engine' 'FAIL' 'printEngine is browser' }
    else { Add-Result 'print-engine' 'MANUAL' 'no printEngine entry; default is dsh' }
  }
} else {
  Add-Result 'profile' 'MANUAL' ('profile not found: ' + $ProfilePath)
}

if (-not $ValidateOnly -and -not $SkipTests) {
  $suites = @(
    'render-check', 'document-config-check', 'print-options-check', 'presets-check',
    'preview-check', 'dsh-preview-check', 'printer-check', 'print-server-check',
    'print-jobs-check', 'export-check', 'after-export-check', 'broker-check', 'client-ui-check'
  )
  foreach ($suite in $suites) {
    $scriptPath = Join-Path $repo ('scripts\' + $suite + '.mjs')
    if (-not (Test-Path -LiteralPath $scriptPath)) {
      Add-Result ('test-' + $suite) 'FAIL' 'script missing'
      continue
    }
    $output = & $node $scriptPath 2>&1
    if ($LASTEXITCODE -ne 0) {
      Add-Result ('test-' + $suite) 'FAIL' (($output | Select-Object -Last 4) -join ' | ')
    } else {
      $line = $output | Select-String -Pattern '(\d+)/(\d+) checks passed' | Select-Object -Last 1
      if ($line) { Add-Result ('test-' + $suite) 'PASS' $line.Line }
      else { Add-Result ('test-' + $suite) 'PASS' 'exit 0' }
    }
  }
  $audit = & $node (Join-Path $repo 'scripts\list-audit.mjs') 2>&1
  $auditLine = $audit | Select-String -Pattern 'failures:' | Select-Object -Last 1
  if ($LASTEXITCODE -eq 0 -and $auditLine -and $auditLine.Line -match 'builtin=0\s+markdown\(old\)=0\s+gfm\+math=0') {
    Add-Result 'list-audit' 'PASS' $auditLine.Line
  } else {
    Add-Result 'list-audit' 'FAIL' (($audit | Select-Object -Last 3) -join ' | ')
  }
}

$cjk = [string]([char]0x4E2D) + [string]([char]0x6587)
$fixtureDir = Join-Path $WorkDir ('dsh-' + $cjk + ' path')
New-Item -ItemType Directory -Force -Path $fixtureDir | Out-Null

$sample = Join-Path $repo 'samples\sample.md'
if (Test-Path -LiteralPath $sample) {
  $gongwenText = [IO.File]::ReadAllText($sample, [Text.Encoding]::UTF8)
  $regex = New-Object System.Text.RegularExpressions.Regex '^---\r?\n'
  $gongwenText = $regex.Replace($gongwenText, "---`r`npdf.preset: gongwen`r`npdf.pageNumbers: true`r`n", 1)
  Write-Utf8 (Join-Path $fixtureDir 'gongwen.md') $gongwenText
} else {
  Add-Result 'fixture-gongwen' 'FAIL' 'samples/sample.md missing'
}

$numbers = @'
---
pdf.preset: lark
pdf.pageNumbers: true
---

# Page numbers only

Paragraph one for the footer test.

Paragraph two for the footer test.

Paragraph three for the footer test.
'@
Write-Utf8 (Join-Path $fixtureDir 'numbers.md') $numbers

$header = @'
---
pdf.preset: lark
pdf.header: Header Test
---

# Header only

Body text.
'@
Write-Utf8 (Join-Path $fixtureDir 'header.md') $header

$footer = @'
---
pdf.preset: lark
pdf.footer: Footer Test
---

# Footer only

Body text.
'@
Write-Utf8 (Join-Path $fixtureDir 'footer.md') $footer

$toc = @'
---
pdf.preset: lark
pdf.toc: true
---

# Chapter One

## Section One

Body text.

# Chapter Two

More text.
'@
Write-Utf8 (Join-Path $fixtureDir 'toc.md') $toc

$paper = @'
---
pdf.preset: paper
lang: en-US
pdf.paper.title: A Sample Paper
pdf.paper.authors: Zhang San, Li Si
pdf.paper.affiliations: Example University
pdf.paper.abstract: This is the abstract of the sample paper.
pdf.paper.keywords: markdown; pdf; layout
pdf.paper.date: 2026-11-15
---

# 1 Introduction

Body text.
'@
Write-Utf8 (Join-Path $fixtureDir 'paper.md') $paper

$pagebreak = @'
---
pdf.preset: lark
---

# Page break test

First page content.

<!-- pagebreak -->

Second page content.
'@
Write-Utf8 (Join-Path $fixtureDir 'pagebreak.md') $pagebreak

$browser = @'
---
pdf.preset: lark
---

# Browser fallback test

First page content.

<!-- pagebreak -->

Second page content.
'@
Write-Utf8 (Join-Path $fixtureDir 'browser.md') $browser

$lock = @'
---
pdf.preset: lark
---

# Lock test

Old content.
'@
Write-Utf8 (Join-Path $fixtureDir 'lock.md') $lock

$promptLines = @(
  'Use the md2pdf_export tool on each file below, one at a time.',
  'Report ok, engine, bytes, and pdfPath for each.',
  '',
  '1. ' + (Join-Path $fixtureDir 'gongwen.md'),
  '2. ' + (Join-Path $fixtureDir 'numbers.md'),
  '3. ' + (Join-Path $fixtureDir 'header.md'),
  '4. ' + (Join-Path $fixtureDir 'footer.md'),
  '5. ' + (Join-Path $fixtureDir 'toc.md'),
  '6. ' + (Join-Path $fixtureDir 'paper.md'),
  '7. ' + (Join-Path $fixtureDir 'pagebreak.md'),
  '',
  'Then export the test page from Settings > Test print.',
  'A path with Chinese characters and spaces is intentional.'
)
Write-Utf8 (Join-Path $WorkDir 'DSH-PROMPT.txt') ($promptLines -join "`r`n")

$cli = Join-Path $repo 'scripts\export-cli.mjs'
if (-not $ValidateOnly) {
  $pagebreakPath = Join-Path $fixtureDir 'browser.md'
  $output = & $node $cli $pagebreakPath 2>&1
  if ($LASTEXITCODE -ne 0) {
    Add-Result 'browser-fallback' 'FAIL' (($output | Select-Object -Last 4) -join ' | ')
  } else {
    $pdf = [IO.Path]::ChangeExtension($pagebreakPath, '.pdf')
    if (Test-Path -LiteralPath $pdf) {
      $info = Get-PdfInfo $pdf $node
      if ($info) { Add-Result 'browser-fallback' 'PASS' ('pdf=' + $pdf + ' pages=' + $info.pages) }
      else { Add-Result 'browser-fallback' 'FAIL' 'pdf-info could not read the browser PDF' }
    } else {
      Add-Result 'browser-fallback' 'FAIL' 'no PDF written'
    }
  }

  $lockPath = Join-Path $fixtureDir 'lock.md'
  $lockPdf = [IO.Path]::ChangeExtension($lockPath, '.pdf')
  $first = & $node $cli $lockPath 2>&1
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $lockPdf)) {
    Add-Result 'file-lock' 'SKIP' 'the first browser export failed'
  } else {
    $before = (Get-FileHash -LiteralPath $lockPdf -Algorithm SHA256).Hash
    $handle = [IO.File]::Open($lockPdf, 'Open', 'ReadWrite', 'None')
    try {
      $second = & $node $cli $lockPath 2>&1
      $secondExit = $LASTEXITCODE
    } finally {
      $handle.Close()
    }
    $after = (Get-FileHash -LiteralPath $lockPdf -Algorithm SHA256).Hash
    $staging = Get-ChildItem -LiteralPath $fixtureDir -Filter '*.md2pdf-*.pdf.tmp' -Force -ErrorAction SilentlyContinue
    if ($secondExit -eq 0) { Add-Result 'file-lock' 'FAIL' 'the second export succeeded while the PDF was locked' }
    elseif ($after -ne $before) { Add-Result 'file-lock' 'FAIL' 'the locked PDF changed' }
    elseif ($staging) { Add-Result 'file-lock' 'FAIL' 'a staging file was left behind' }
    else { Add-Result 'file-lock' 'PASS' 'second export refused; old PDF unchanged; no staging file' }
  }
}

function Test-PdfCase {
  param(
    [string]$Name,
    [string]$Path,
    [int]$Pages = 0,
    [bool]$A4 = $true,
    [bool]$Outline = $false,
    [string]$FontPattern = ''
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    Add-Result $Name 'MANUAL' ('PDF missing; export it through DSH, then rerun -ValidateOnly: ' + $Path)
    return
  }
  $info = Get-PdfInfo $Path $node
  if ($null -eq $info) { Add-Result $Name 'FAIL' 'pdf-info could not read the file'; return }
  if ($Pages -gt 0 -and [int]$info.pages -ne $Pages) {
    Add-Result $Name 'FAIL' ('pages=' + $info.pages + ', expected ' + $Pages)
    return
  }
  if ($A4) {
    $width = 0.0
    $height = 0.0
    foreach ($box in @($info.boxes)) {
      $match = [regex]::Match([string]$box, '\[\s*[0-9.]+\s+[0-9.]+\s+([0-9.]+)\s+([0-9.]+)\s*\]')
      if ($match.Success) { $width = [double]$match.Groups[1].Value; $height = [double]$match.Groups[2].Value }
    }
    if ($width -eq 0 -or [Math]::Abs($width - 594.96) -gt 2 -or [Math]::Abs($height - 841.92) -gt 2) {
      Add-Result $Name 'FAIL' ('page box ' + $width + 'x' + $height + ' is not A4')
      return
    }
  }
  $raw = [Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes($Path))
  $hasOutline = $raw.Contains('/Outlines')
  if ($Outline -and -not $hasOutline) { Add-Result $Name 'FAIL' 'no /Outlines'; return }
  $fontText = (@($info.fonts) -join ' ')
  if ($FontPattern -and $fontText -notmatch $FontPattern) {
    Add-Result $Name 'FAIL' ('fonts do not match ' + $FontPattern + ': ' + $fontText)
    return
  }
  Add-Result $Name 'PASS' ('pages=' + $info.pages + ' outline=' + $hasOutline + ' fonts=' + $fontText)
}

$anyPdf = @(Get-ChildItem -LiteralPath $fixtureDir -Filter '*.pdf' -ErrorAction SilentlyContinue).Count -gt 0
if ($ValidateOnly -or $anyPdf) {
  Test-PdfCase 'dsh-gongwen' (Join-Path $fixtureDir 'gongwen.pdf') 4 $true $true 'FangSong|KaiTi|SimSun'
  Test-PdfCase 'dsh-numbers' (Join-Path $fixtureDir 'numbers.pdf') 0 $true $false ''
  Test-PdfCase 'dsh-header' (Join-Path $fixtureDir 'header.pdf') 0 $true $false ''
  Test-PdfCase 'dsh-footer' (Join-Path $fixtureDir 'footer.pdf') 0 $true $false ''
  Test-PdfCase 'dsh-toc' (Join-Path $fixtureDir 'toc.pdf') 2 $true $false ''
  Test-PdfCase 'dsh-paper' (Join-Path $fixtureDir 'paper.pdf') 1 $true $false ''
  Test-PdfCase 'dsh-pagebreak' (Join-Path $fixtureDir 'pagebreak.pdf') 2 $true $false ''
  $md2pdfHome = $env:MD2PDF_HOME
  if (-not $md2pdfHome) { $md2pdfHome = Join-Path $env:USERPROFILE '.dsh\md2pdf' }
  Test-PdfCase 'test-print' (Join-Path $md2pdfHome 'test-print\test-print.pdf') 1 $true $false ''
}

if (Test-Path -LiteralPath $profilePackage) {
  if (-not ($dependency -and (Test-Path -LiteralPath (Join-Path $ProfilePath 'node_modules\dsh-md2pdf')))) {
    Write-Host ''
    Write-Host 'Link setup (one time, then restart DSH):'
    Write-Host ('1. Add "dsh-md2pdf": "link:' + $repo.Replace('\', '/') + '" to ' + $profilePackage)
    Write-Host '2. Add "dsh-md2pdf" to dsh.profile.bundles.'
    Write-Host ('3. Add the md2pdf block with printEngine: dsh to ' + (Join-Path $ProfilePath 'cordis.patch.yml'))
    Write-Host '4. Run pnpm install in the profile if your install uses pnpm.'
  }
}

Write-Host ''
Write-Host '== Summary =='
$script:Results | Format-Table -AutoSize
$failures = @($script:Results | Where-Object { $_.Status -eq 'FAIL' })
if ($failures.Count -gt 0) {
  Write-Host ('FAILED: ' + $failures.Count + ' automatic check(s).') -ForegroundColor Red
  exit 1
}
Write-Host 'Automatic checks passed. DSH export checks are PASS only when the PDFs exist.'
Write-Host ('Fixtures: ' + $fixtureDir)
Write-Host ('DSH prompt: ' + (Join-Path $WorkDir 'DSH-PROMPT.txt'))
