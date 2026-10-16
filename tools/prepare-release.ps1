$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$result = & node (Join-Path $PSScriptRoot 'release-check.mjs') --export
if ($LASTEXITCODE -ne 0) { throw ($result -join "`n") }
$release = ($result -join "`n") | ConvertFrom-Json
$sourceRoot = [IO.Path]::GetFullPath($release.output)
$expectedParent = [IO.Path]::GetFullPath((Join-Path $projectRoot 'artifacts\releases')) + [IO.Path]::DirectorySeparatorChar
if (!$sourceRoot.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase)) { throw 'Release path is outside the project release directory.' }
$archive = $sourceRoot + '.zip'
if (Test-Path -LiteralPath $archive) { throw 'Release archive already exists.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
# ZipFile includes dotfiles; keep .github, .gitignore and .env.example in the ZIP.
[IO.Compression.ZipFile]::CreateFromDirectory($sourceRoot, $archive, [IO.Compression.CompressionLevel]::Optimal, $true)
$digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($archive + '.sha256', $digest + '  ' + [IO.Path]::GetFileName($archive) + "`n")
[pscustomobject]@{ archive = $archive; sha256 = $digest; source = $sourceRoot; files = $release.fileCount; bytes = (Get-Item -LiteralPath $archive).Length } | ConvertTo-Json
