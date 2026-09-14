# Personal documents: transfer the existing local commits

This is a source-transfer instruction, not implementation acceptance, a new business feature, or independent review. Keep main unchanged. The repository-side connection can write again, but it cannot read the user's Windows disk. The personal-documents branch and the reported final commits were not accessible on GitHub when this handoff was prepared.

## Exact requested source

- Repository: `youq616/ultrabrain`
- Local clone reported by the user: `C:\Users\Administrator\Documents\project\ultrabrain-personal-documents`
- Branch: `development/personal-documents`
- Base: `09a4c8fe95242d5939e28cc3957d4605a6823a81`
- Implementation: `8fc75aa4949baffc5c3c4c5f4c1df6376d28ba8c`
- Reviewed correction: `2e10b9c88920d0b49f73cf71f2033e45272683ff`
- Reported documentation-only head: `1e60ac891b22a307f42cbfeaa3e8637299266336`

The local report describes a conditional independent approval; the raw review records and code have not yet been independently inspected by the repository-side assistant. Do not treat this handoff as proof of approval or Linux CI success. Verify that the last commit really is documentation-only.

## Local Agent task

Export only these existing committed objects, including the committed review records. Do not develop more code, rebase, amend, reset, stash, merge, configure Git credentials, push, install WSL/PostgreSQL, run a production service or change Agent settings. Uncommitted and untracked files must remain unchanged and are not included. Check all three commit diffs for credentials, personal transcripts, databases or other unintended content before exporting: a bundle includes intermediate committed versions, not just the final net diff. If sensitive committed content is present, stop and report only safe filenames/categories; do not rewrite the reviewed commits or upload it.

Use an incremental Git bundle, not a ZIP of the entire local clone, `.git`, home directory or `node_modules`. A bundle includes commit metadata such as author name/email and messages. It needs the exact base commit at the receiving end; this public base is available separately. Do not use `git bundle --all` or `git format-patch` through PowerShell text redirection.

## PowerShell export commands

Run only after the above content check. Any mismatch or command failure stops the handoff, without trying to repair or overwrite the branch. The export creates a new unique output directory outside the worktree and performs no remote network or authentication operation.

```powershell
$ErrorActionPreference = 'Stop'
$Repo = 'C:\Users\Administrator\Documents\project\ultrabrain-personal-documents'
$Base = '09a4c8fe95242d5939e28cc3957d4605a6823a81'
$Head = '1e60ac891b22a307f42cbfeaa3e8637299266336'
$Ref = 'refs/heads/development/personal-documents'
$Expected = @('8fc75aa4949baffc5c3c4c5f4c1df6376d28ba8c', '2e10b9c88920d0b49f73cf71f2033e45272683ff', $Head)
function Read-Git([string[]] $Arguments) {
    $Result = & git --no-optional-locks -C $Repo @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Git command failed; stop without modifying the repository.' }
    return $Result
}
$Actual = Read-Git @('rev-parse', '--verify', "$Ref^{commit}")
if ($Actual -ne $Head) { throw 'Branch head differs from the requested head; preserve it and report the actual SHA.' }
$Commits = @(Read-Git @('rev-list', '--reverse', "$Base..$Head"))
if (($Commits -join ',') -ne ($Expected -join ',')) { throw 'Commit range differs; do not export unrelated history.' }
Read-Git @('merge-base', '--is-ancestor', $Base, $Head) | Out-Null
$Before = @(Read-Git @('status', '--porcelain=v1', '--untracked-files=normal'))
$Tree = Read-Git @('rev-parse', "$Head^{tree}")
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable; choose a private output location outside the repository.' }
$Out = Join-Path $env:LOCALAPPDATA ('Ultrabrain\handoff\personal-documents-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Out -ErrorAction Stop | Out-Null
$Bundle = Join-Path $Out 'personal-documents.bundle'
Read-Git @('bundle', 'create', '--version=2', $Bundle, $Ref, "^$Base") | Out-Null
Read-Git @('bundle', 'verify', $Bundle) | Out-Null
$Heads = @(Read-Git @('bundle', 'list-heads', $Bundle))
if ($Heads.Count -ne 1 -or $Heads[0] -ne "$Head $Ref") { throw 'Unexpected advertised bundle ref; do not upload.' }
$AfterHead = Read-Git @('rev-parse', '--verify', "$Ref^{commit}")
$After = @(Read-Git @('status', '--porcelain=v1', '--untracked-files=normal'))
if ($AfterHead -ne $Head -or ($Before -join "`n") -ne ($After -join "`n")) { throw 'Repository changed during export; preserve the files but do not upload without investigation.' }
$Manifest = Join-Path $Out 'handoff-manifest.json'
$Info = [ordered]@{
    format = 1
    repository = 'youq616/ultrabrain'
    base_commit = $Base
    head_commit = $Head
    head_tree = $Tree
    source_ref = $Ref
    commits = $Commits
    bundle_sha256 = (Get-FileHash -LiteralPath $Bundle -Algorithm SHA256).Hash.ToLowerInvariant()
    bundle_verified_locally = $true
    worktree_status_unchanged = $true
    contains_uncommitted_files = $false
    acceptance = 'Not accepted by this export; Linux CI and review evidence remain separate gates.'
}
$Info | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Manifest -Encoding UTF8
$Zip = Join-Path $Out 'ultrabrain-personal-documents-handoff.zip'
Compress-Archive -LiteralPath @($Bundle, $Manifest) -DestinationPath $Zip -ErrorAction Stop
Write-Output ('ZIP: ' + $Zip)
Write-Output ('ZIP_SHA256: ' + (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant())
Write-Output ('HEAD: ' + $Head)
Write-Output ('TREE: ' + $Tree)
```

Upload only `ultrabrain-personal-documents-handoff.zip` to the current conversation, plus its SHA-256 and the exact HEAD/tree. Merely pasting the Windows path does not transfer the bytes. Do not send passwords, tokens, a full local clone, shell history or private raw logs. No GitHub push credential is needed for this export.

## Receiving-side obligations

Verify the ZIP/bundle fingerprints, bundle prerequisites, commit objects, exact reviewed source tree and documentation-only tail. Inspect raw review evidence and all changed code rather than adopting the implementation summary. Preserve the original local bundle/commit provenance; if a connector recreates a remote commit with a different SHA, report that fact, compare the source tree and request independent review on the remote candidate rather than pretending it has the old SHA. Then run same-candidate Linux/PostgreSQL/MCP/console/restore CI, address the client-package integration gap, obtain independent review of fixes and merge only after all gates are satisfied.

The incremental bundle round-trip was tested here with synthetic local Git repositories: three-commit import preserved exact commit/tree IDs and excluded an untracked test file while leaving the source worktree status unchanged. That is a Git transfer check, not a Windows execution test or personal-documents product test.
