param([ValidateSet('All','QQ','WeChat')][string]$Component = 'All')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$artifactRoot = Join-Path $projectRoot 'artifacts'
New-Item -ItemType Directory -Force $artifactRoot | Out-Null
if ($Component -in @('All','QQ')) {
  $archive = Join-Path $artifactRoot 'NapCat.Shell.v4.18.38.zip'
  $expected = '735F2E633247DF3FFD6E8EE8B84D7039C315B2655F5807E5F0029F93D2C30016'
  if (!(Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.38/NapCat.Shell.zip' -OutFile $archive
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'NapCat archive checksum mismatch. Do not run it.' }
  $destination = Join-Path $projectRoot 'vendor\napcat'
  New-Item -ItemType Directory -Force $destination | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
  Copy-Item -LiteralPath (Join-Path $projectRoot 'vendor\NapCat.LICENSE') -Destination (Join-Path $destination 'LICENSE')
  Write-Output 'QQ connector installed (NapCat v4.18.38). Official Windows QQ is also required.'
}
if ($Component -in @('All','WeChat')) {
  $environmentRoot = Join-Path $projectRoot '.venv-wechat'
  if (!(Test-Path -LiteralPath (Join-Path $environmentRoot 'Scripts\python.exe'))) {
    & py -3.10 -m venv $environmentRoot
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 x64 is required for the WeChat connector.' }
  }
  # Download official wheels with PowerShell so an old pip/proxy combination
  # cannot force users to disable HTTPS certificate verification.
  $wheelRoot = Join-Path $artifactRoot 'python-wheels'
  New-Item -ItemType Directory -Force $wheelRoot | Out-Null
  $packages = @{ pywinauto='0.6.9'; comtypes='1.4.17'; six='1.17.0'; pywin32='312'; Pillow='12.0.0'; pycryptodome='3.23.0'; frida='17.8.0'; zstandard='0.25.0' }
  foreach ($packageName in $packages.Keys) {
    $version = $packages[$packageName]
    $metadata = Invoke-RestMethod "https://pypi.org/pypi/$packageName/$version/json"
    $wheel = $metadata.urls | Where-Object { $_.filename -match '(none-any|cp310-cp310-win_amd64|cp37-abi3-win_amd64)\.whl$' } | Select-Object -First 1
    if (!$wheel) { throw "No compatible x64 wheel for $packageName" }
    $wheelPath = Join-Path $wheelRoot $wheel.filename
    if (!(Test-Path -LiteralPath $wheelPath)) { Invoke-WebRequest $wheel.url -OutFile $wheelPath }
    if ((Get-FileHash -LiteralPath $wheelPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $wheel.digests.sha256) { throw "Wheel checksum mismatch: $packageName" }
  }
  & (Join-Path $environmentRoot 'Scripts\python.exe') -m pip install --no-index --find-links $wheelRoot pywinauto==0.6.9 comtypes==1.4.17 six==1.17.0 pywin32==312 Pillow==12.0.0 pycryptodome==3.23.0 frida==17.8.0 zstandard==0.25.0
  if ($LASTEXITCODE -ne 0) { throw 'WeChat dependency installation failed.' }
  Write-Output 'WeChat local database reader installed. Official Windows Weixin 4.x is also required.'
}
