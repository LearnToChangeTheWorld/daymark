param([Parameter(Mandatory=$true)][string]$ImagePath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
$ocrAwaitMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1 } | Select-Object -First 1
function Wait-OcrOperation($Operation, [Type]$ResultType) {
    $ocrTask = $ocrAwaitMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $ocrTask.Wait()
    return $ocrTask.Result
}
$ocrFile = Wait-OcrOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path -LiteralPath $ImagePath).Path)) ([Windows.Storage.StorageFile])
$ocrStream = Wait-OcrOperation ($ocrFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
    $ocrDecoder = Wait-OcrOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ocrStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $ocrBitmap = Wait-OcrOperation ($ocrDecoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $ocrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $ocrEngine) { throw 'No local OCR language installed' }
    $ocrResult = Wait-OcrOperation ($ocrEngine.RecognizeAsync($ocrBitmap)) ([Windows.Media.Ocr.OcrResult])
    $ocrLines = @($ocrResult.Lines | ForEach-Object {
        $ocrWords = @($_.Words | ForEach-Object { @{ text=$_.Text; x=$_.BoundingRect.X; y=$_.BoundingRect.Y; width=$_.BoundingRect.Width; height=$_.BoundingRect.Height } })
        @{ text=$_.Text; words=$ocrWords }
    })
    @{ lines=$ocrLines } | ConvertTo-Json -Depth 6 -Compress
    $ocrBitmap.Dispose()
} finally { $ocrStream.Dispose() }
