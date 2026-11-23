param(
    [Parameter(Mandatory=$true)][string]$Output,
    [string]$WebViewSdkArchive,
    [string]$NodeLicense
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path ([IO.Path]::GetTempPath()) ('wangwang-desktop-' + [guid]::NewGuid().ToString('N'))
$game = Join-Path $work 'game'
$sdk = Join-Path $work 'sdk'
New-Item -ItemType Directory -Path $game, $sdk | Out-Null

$node = (Get-Command node.exe).Source
if ((& $node -p 'process.arch') -ne 'x64') { throw 'The desktop package requires an x64 Node executable.' }
$version = (& $node -p 'process.version').Trim()
if ([version]$version.TrimStart('v') -lt [version]'22.18.0') { throw 'Install Node.js 22.18 or newer.' }

if (!$WebViewSdkArchive) {
    $WebViewSdkArchive = Join-Path $work 'webview2.zip'
    $sdkVersion = '1.0.3124.44'
    $sdkUrl = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg"
    Invoke-WebRequest -Uri $sdkUrl -OutFile $WebViewSdkArchive
}
# Expand-Archive expects a ZIP extension, whereas NuGet often supplies .nupkg.
$sdkZip = Join-Path $work 'sdk.zip'
Copy-Item -LiteralPath $WebViewSdkArchive -Destination $sdkZip
Expand-Archive -LiteralPath $sdkZip -DestinationPath $sdk

if (!$NodeLicense) {
    $NodeLicense = Join-Path $work 'Node-LICENSE.txt'
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/$version/LICENSE" -OutFile $NodeLicense
}
Copy-Item -LiteralPath $NodeLicense -Destination (Join-Path $game 'Node-LICENSE.txt')
Copy-Item -LiteralPath $node -Destination (Join-Path $game 'node.exe')

$gameFiles = @('engine', 'server.js', 'accounts.js', 'league.js', 'replay-data.js',
    'index.html', 'account-ui.js', 'replay.js', 'tiles.js', 'meshes.js', 'table.css',
    'faces.png', 'tiles.glb', 'tiles.glb.gz', 'package.json', 'package-lock.json')
foreach ($file in $gameFiles) {
    Copy-Item -LiteralPath (Join-Path $root $file) -Destination $game -Recurse
}
Push-Location $game
try {
    npm.cmd ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Could not install game dependencies.' }
}
finally { Pop-Location }

$assemblies = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll')
foreach ($name in $assemblies) {
    Copy-Item -LiteralPath (Join-Path $sdk "lib/net462/$name") -Destination $game
}
Copy-Item -LiteralPath (Join-Path $sdk 'runtimes/win-x64/native/WebView2Loader.dll') -Destination $game
Copy-Item -LiteralPath (Join-Path $sdk 'LICENSE.txt') -Destination (Join-Path $game 'WebView2-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $sdk 'NOTICE.txt') -Destination (Join-Path $game 'WebView2-NOTICE.txt')

$package = Join-Path $work 'game.zip'
Compress-Archive -Path (Join-Path $game '*') -DestinationPath $package -CompressionLevel Optimal
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$references = $assemblies | ForEach-Object { '/reference:' + (Join-Path $game $_) }
$outputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Output)
$compile = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+',
    ('/win32manifest:' + (Join-Path $PSScriptRoot 'app.manifest')),
    ('/out:' + $outputPath), ('/resource:' + $package + ',WangWangRiichi.Game.zip'),
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
    '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll')
& $compiler @compile @references (Join-Path $PSScriptRoot 'Program.cs')
if ($LASTEXITCODE -ne 0) { throw 'Desktop EXE compilation failed.' }
Get-Item -LiteralPath $outputPath
