# Personal-ranking：只转交未推送的原始提交

这是交接操作说明，不是 personal-ranking 的验收报告。远程主线在核实时仍为 `5f175cb4b4ba7f8d603ee9a61b59c414ab983e0d`；本地报告的排序分支尚未推送。仓库端 GitHub 创建分支/提交接口本次已实际写入成功，因此本地无需继续处理推送权限。唯一需要本地做的是导出电脑上独有的三次提交，并由用户把 ZIP 附件上传到当前会话。

## 固定输入与下载

本地仓库：`C:\Users\Administrator\Documents\project\ultrabrain-personal-ranking`。
分支：`development/personal-ranking`。
提交链必须严格为：

```text
5f175cb4b4ba7f8d603ee9a61b59c414ab983e0d
  -> 4fda603bdcb0726d99b115e61796f85612d3c009
  -> 14e43fa8a727758ec93046e3a2d41ed0e1ea5205
  -> bcef3abfb92aef95567e5949e70c8e7ba25ab6d4
```

`14e43fa8…` 是本地报告的受审实现，`bcef3ab…` 必须只是 docs 目录内的审核记录。不能把条件批准转述为 Linux CI 已通过。执行脚本会重新核对父子链、分支、干净工作区、完整克隆、导出前后状态以及唯一 bundle ref 和基线依赖。

导出脚本固定提交：`8e2e9e0e31a10cc54fc290881db9c6c18a8709db`。
路径：`scripts/handoffs/export-personal-ranking.py`。
脚本 SHA-256：`92e524aa13387bc8b68743d814ce8be8b95d199961c9c81c96a3641780641ea9`。

先确认已有 Python 3.10+ 和 Git，不需要安装额外依赖。在 PowerShell 中下载到工作仓库以外的用户私有目录：

```powershell
$ErrorActionPreference = 'Stop'
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable; choose an existing private user directory.' }
$parent = Join-Path $env:LOCALAPPDATA 'Ultrabrain\handoff'
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$tools = Join-Path $parent ('ranking-export-tools-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tools | Out-Null
$script = Join-Path $tools 'export-personal-ranking.py'
Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/youq616/ultrabrain/8e2e9e0e31a10cc54fc290881db9c6c18a8709db/scripts/handoffs/export-personal-ranking.py' -OutFile $script
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $script).Hash.ToLowerInvariant()
if ($actual -ne '92e524aa13387bc8b68743d814ce8be8b95d199961c9c81c96a3641780641ea9') { throw 'Exporter checksum mismatch. Do not run.' }
Get-Content -Raw -Encoding UTF8 -LiteralPath $script
```

下载公开文件不需要 GitHub 写入凭据。执行前检查这三次新增提交的全部内容与中间版本，确认没有真实记忆、数据库、密码、Token、私钥或其他不应分享的资料；审核记录和作者信息也会随提交传输。脚本不是秘密检测器，不能把模式扫描零命中当成绝对安全证明。若发现敏感内容、不是预期提交、工作区不干净或版本不符，停止并报告脱敏原因，不能重写原受审提交以绕过检查。

## 执行导出

完成上述实际内容检查后，在同一 PowerShell 中运行（`python` 替换为本机已经确认可用的 Python 命令，不安装新环境）：

```powershell
python $script --repo 'C:\Users\Administrator\Documents\project\ultrabrain-personal-ranking' --output-parent $parent --confirm-reviewed-content
if ($LASTEXITCODE -ne 0) { throw 'Export failed; do not upload incomplete output.' }
```

输出是一个 JSON 对象，含 ZIP 的完整路径、ZIP/bundle SHA-256、完整 HEAD/tree 与 `bundle_verify: passed`。ZIP 仅含 `personal-ranking.bundle` 和 `handoff-manifest.json`。不包含整个 `.git` 目录、未提交文件、node_modules、下载脚本或命令日志。每次创建唯一新目录，不覆盖旧导出。失败会保留 INCOMPLETE 标记，不应上传失败目录。

本工具不 fetch/push、不请求凭据、不执行产品测试、不部署服务，不修改工作区、分支或提交；只对已经存在的 Git 对象执行读取和增量 bundle 导出。Windows 输出目录需使用用户私有 ACL，脚本不擅自修改 ACL。

**最后必须让用户把 `ultrabrain-personal-ranking-handoff.zip` 文件作为附件上传到当前会话。只有文件路径、Markdown 图标或文字总结不传输文件字节。**回复时同时给 ZIP SHA-256、HEAD/tree 和核验结果；不要要求用户登录 GitHub、创建 PR、运行 Linux 或重做代码。

## 仓库端实际验证范围

脚本已在 Linux 临时合成 Git 仓库执行 9 项测试：精确 bundle 往返保持原提交和树；缺少内容确认拒绝；脏工作区保持不变；输出位于项目内拒绝；HEAD 不符拒绝；origin 不符拒绝且不回显其中凭据；末次夹带代码拒绝；提交链错误拒绝；重复导出使用不同新目录。9/9 通过，日志 SHA-256 为 `5d942fc957bbafd075bbfc4db1a1e9ea386225fe0320f74929934848ebe1fcfa`。远程脚本 blob `c09dc8c9119b8f90edc4e30968bcf5333e0670c0` 已与实际测试文件一致核对。

这只是交接工具的实施者验证，不是另一个独立代理的排序代码审核，也不是 Windows 本机执行结果。未收到原始 bundle 前，不声称已阅读/运行本地三次提交。源码交付后，仓库端继续核对原始对象、建立 PR、执行相应 Linux CI 和当前提交的独立审核；在批准条件满足前不合并 main。本交接分支不合入产品主线。
