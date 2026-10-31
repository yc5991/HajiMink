[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
function Get-ContentSha256([string] $file) {
    $fileHasher = [Security.Cryptography.SHA256]::Create()
    $fileStream = [IO.File]::OpenRead($file)
    try { return [BitConverter]::ToString($fileHasher.ComputeHash($fileStream)).Replace('-','') }
    finally { $fileStream.Dispose(); $fileHasher.Dispose() }
}
$inventoryText = & node (Join-Path $PSScriptRoot 'check-release.mjs') --list
if ($LASTEXITCODE -ne 0) { throw '发布源文件检查未通过，请先处理报告中的文件' }
$inventory = $inventoryText | ConvertFrom-Json
if ($inventory.version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw '项目版本不能用作发布文件名' }
$outputRoot = Join-Path $projectRoot 'output\opensource'
$name = 'hajimink-' + $inventory.version + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$stage = [IO.Path]::GetFullPath((Join-Path $outputRoot $name))
if (-not $stage.StartsWith([IO.Path]::GetFullPath($outputRoot) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '发布目录越界' }
if (Test-Path -LiteralPath $stage) { throw '发布目录已存在，请稍后再试' }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($relative in $inventory.files) {
    $target = [IO.Path]::GetFullPath((Join-Path $stage $relative))
    if (-not $target.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '发布文件路径越界' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot $relative) -Destination $target
}
& node (Join-Path $stage 'scripts\check-release.mjs')
if ($LASTEXITCODE -ne 0) { throw '打包副本检查未通过' }
$zipPath = $stage + '.zip'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$writer = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($relative in $inventory.files) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($writer, (Join-Path $stage $relative), $relative, [IO.Compression.CompressionLevel]::Optimal) | Out-Null }
} finally { $writer.Dispose() }
$archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $entries = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') -and -not $_.FullName.EndsWith('\') })
    if ($entries.Count -ne $inventory.files.Count) { throw '压缩包文件数量与发布清单不符' }
    foreach ($relative in $inventory.files) {
        $entry = $entries | Where-Object { $_.FullName.Replace('\','/') -eq $relative } | Select-Object -First 1
        if (-not $entry) { throw ('压缩包缺少文件：' + $relative) }
        $entryStream = $entry.Open()
        $entryHasher = [Security.Cryptography.SHA256]::Create()
        try { $entryHash = [BitConverter]::ToString($entryHasher.ComputeHash($entryStream)).Replace('-','') }
        finally { $entryStream.Dispose(); $entryHasher.Dispose() }
        $stageHash = Get-ContentSha256 (Join-Path $stage $relative)
        $sourceHash = Get-ContentSha256 (Join-Path $projectRoot $relative)
        if ($entryHash -ne $stageHash -or $entryHash -ne $sourceHash) { throw ('发布文件与当前源码不一致：' + $relative) }
    }
} finally { $archive.Dispose() }
$hasher = [Security.Cryptography.SHA256]::Create()
$stream = [IO.File]::OpenRead($zipPath)
try { $checksum = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
finally { $stream.Dispose(); $hasher.Dispose() }
($checksum + '  ' + (Split-Path -Leaf $zipPath)) | Set-Content -LiteralPath ($zipPath + '.sha256') -Encoding ascii
@{ directory=$stage; archive=$zipPath; sha256=$checksum; files=$inventory.files.Count } | ConvertTo-Json
