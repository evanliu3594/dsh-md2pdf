# S1 checklist: DSH Chromium printer on macOS and Windows

This file records the manual S1 gate for Task 4. Do not mark the task complete
until both platforms pass. The controller or the user runs every step below; the
implementation session does not install, link, or restart DSH.

Branch under test: `v2-dsh-printing`
Commit under test: ____________________
Plugin repository path used for the link: ____________________
DSH Desktop version: ____________________

The Task 4 commit lives on branch `v2-dsh-printing`. Before the macOS run,
either check that commit out at `/Users/liu/Desktop/gitdir/dsh-md2pdf`, or use
the worktree path
`/Users/liu/Desktop/gitdir/dsh-md2pdf/.agents/worktrees/v2-dsh-printing` as the
link target. Write the path actually used in the metadata line above.

## Shared preconditions

- The repository at the link path is checked out at the commit above. A Git
  worktree of the same repository is acceptable.
- The plugin is linked into the DSH Desktop profile; the profile package manager
  resolved the link without an install error.
- The gongwen preset (`红头公文`, id `gongwen`) is selected for the export.
- Record the command output, not a summary, in each result line.

## macOS S1

Platform: macOS ____________________ (`sw_vers -productVersion`)
Node used by the profile: ____________________ (`node --version`)
Poppler available: ____________________ (`pdfinfo -v`)

### Step 1: link the plugin and restart DSH

1. Edit `~/.dsh/profiles/desktop/package.json`:

   ```json
   "dependencies": {
     "dsh-md2pdf": "link:/Users/liu/Desktop/gitdir/dsh-md2pdf"
   }
   ```

   Append `"dsh-md2pdf"` to `dsh.profile.bundles` in the same file.

2. Run the profile package manager:

   ```bash
   cd ~/.dsh/profiles/desktop
   /Users/liu/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node \
     /Users/liu/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs install
   ```

3. Quit DSH Desktop completely, then reopen it.

Expected: the install exits 0, `node_modules/dsh-md2pdf` resolves to the repository
path, and the plugin row loads without a client error.

Result: ______________________________________________

### Step 2: select the DSH engine

Add this entry to `~/.dsh/profiles/desktop/cordis.patch.yml`, or set the same
field in the plugin row configuration:

```yaml
- id: md2pdf
  name: dsh-md2pdf
  config:
    printEngine: dsh
```

Restart DSH Desktop again.

Expected: Settings shows `Print engine: DSH built-in`.

Result: ______________________________________________

### Step 3: export the sample with the gongwen preset

1. Remove any old output so creation is observable:

   ```bash
   rm -f /Users/liu/Desktop/gitdir/dsh-md2pdf/samples/sample.pdf
   ```

2. In DSH, select the gongwen preset in Settings → dsh-md2pdf.
3. Open `samples/sample.md` in the sidebar.
4. Run Export to PDF from the file context menu or the tab toolbar.

Expected: the toast reports `engine: DSH` and names
`/Users/liu/Desktop/gitdir/dsh-md2pdf/samples/sample.pdf`.

Result: ______________________________________________

### Step 4: verify the PDF and the viewer

Run:

```bash
pdfinfo /Users/liu/Desktop/gitdir/dsh-md2pdf/samples/sample.pdf
pdffonts /Users/liu/Desktop/gitdir/dsh-md2pdf/samples/sample.pdf
```

Check, in order:

1. Page count is 4.
2. Page size is A4 (595.276 × 841.89 pt, or 594.96 × 841.92 pt).
3. Margins are top 37 mm, right 26 mm, bottom 35 mm, left 28 mm, within
   0.5 mm. Measure in a PDF viewer or with a document measurement tool. Record
   the measured four values.
4. Fonts include `STFangsong` and `STKaiti`.
5. DSH opens the PDF in the right sidebar with the built-in PDF viewer.

Result: ______________________________________________

### Step 5: verify that no external Chromium process ran

Before the export:

```bash
ps -axo pid,ppid,command | grep -E "Microsoft Edge|Google Chrome" | grep -v grep
```

After the export, run the same command. Compare the process identifiers and
start times. Activity Monitor is acceptable when the command output is recorded.

Expected: the export creates no new `Microsoft Edge` or `Google Chrome` child
process; the DSH guest prints inside the app.

Result: ______________________________________________

### macOS gate

PASS / FAIL: ____________________

Notes and exact failure text: ______________________________________________

## Windows S1

Platform: Windows ____________________ (`winver`)
Plugin repository path used for the link: ____________________
Node used by the profile: ____________________ (`node --version`)
Poppler available: ____________________ (`pdfinfo -v`; write `not installed` if absent)

### Step 1: check out the branch, link the plugin, restart DSH

1. Check out the same commit in a Windows repository directory, for example:

   ```bat
   git -C C:\work\dsh-md2pdf fetch --all
   git -C C:\work\dsh-md2pdf worktree add C:\work\dsh-md2pdf-task4 v2-dsh-printing
   ```

2. Edit `%USERPROFILE%\.dsh\profiles\desktop\package.json` and use the Windows
   path of that checkout:

   ```json
   "dependencies": {
     "dsh-md2pdf": "link:C:/work/dsh-md2pdf-task4"
   }
   ```

   Append `"dsh-md2pdf"` to `dsh.profile.bundles`.

3. Run the profile package manager with the Windows DSH runtime paths:

   ```bat
   cd /d "%USERPROFILE%\.dsh\profiles\desktop"
   "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\node.exe" ^
     "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" install
   ```

4. Quit DSH Desktop completely, then reopen it.

Expected: the install exits 0, the link resolves, and the plugin row loads.

Result: ______________________________________________

### Step 2: select the DSH engine

Add the same `md2pdf` patch entry as the macOS step to
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`, or set the field in the
plugin row configuration. Restart DSH Desktop.

Expected: Settings shows `Print engine: DSH built-in`.

Result: ______________________________________________

### Step 3: export a sample whose path contains Chinese and spaces

```bat
mkdir "%USERPROFILE%\Desktop\测试 文档"
copy /Y "C:\work\dsh-md2pdf-task4\samples\sample.md" "%USERPROFILE%\Desktop\测试 文档\样例 文档.md"
```

In DSH, select the gongwen preset, open `样例 文档.md`, and export from the file
context menu or the tab toolbar.

Expected: the toast reports `engine: DSH`; the target is
`%USERPROFILE%\Desktop\测试 文档\样例 文档.pdf`.

Result: ______________________________________________

### Step 4: verify the PDF, viewer, fonts, and process

Use `pdfinfo` and `pdffonts` when installed:

```bat
pdfinfo "%USERPROFILE%\Desktop\测试 文档\样例 文档.pdf"
pdffonts "%USERPROFILE%\Desktop\测试 文档\样例 文档.pdf"
```

Otherwise open the PDF in the DSH viewer and read the document properties, and
record that `pdfinfo` was not installed.

Check, in order:

1. The file opens in the DSH right sidebar.
2. Page count is 4 and the page size is A4.
3. Margins are top 37 mm, right 26 mm, bottom 35 mm, left 28 mm, within
   0.5 mm. Record the measured four values.
4. Fonts resolve to 仿宋, 楷体, and 宋体 (`FangSong`, `KaiTi`, `SimSun`), not a
   generic fallback. Record the actual font names.
5. No new `msedge.exe` or `chrome.exe` process starts because of the export:

   ```bat
   tasklist /FI "IMAGENAME eq msedge.exe"
   tasklist /FI "IMAGENAME eq chrome.exe"
   ```

   Run before and after the export and compare process identifiers.

Result: ______________________________________________

### Step 5: verify the Windows file-busy path

1. Record the current file hash:

   ```bat
   certutil -hashfile "%USERPROFILE%\Desktop\测试 文档\样例 文档.pdf" SHA256
   ```

2. Open the PDF in a viewer that keeps a write lock, such as Adobe Acrobat or
   SumatraPDF. Keep it open.
3. Export the same source again from DSH.
4. Record the error code shown by the plugin. Expect `file-busy` (HTTP 409).
5. Run the hash command again and compare it with the first hash.
6. Close the viewer.

Expected: the second export reports `file-busy`; the old PDF stays intact and
its hash is unchanged.

Result: ______________________________________________

### Windows gate

PASS / FAIL: ____________________

Notes and exact failure text: ______________________________________________

## Final gate

macOS PASS / FAIL: ____________________
Windows PASS / FAIL: ____________________
Both platforms pass: YES / NO
S1 run date and operator: ____________________
