# The two spoken clips tests/e2e/06-voice-isolation.e2e.cjs plays as its synthetic microphone,
# made with Windows' built-in speech synthesizer (System.Speech - offline, no service, no key).
# Two different sentences, so A's content can be told apart from B's in B's session.
#
#   powershell -ExecutionPolicy Bypass -File tests\e2e\make-voice-clips.ps1 [-OutDir <dir>]
#
# Default: %TEMP%\siru-voice-isolation\clips - the test's default E2E_VOICE_CLIPS (outside
# the repo, and outside test-results, which Playwright empties at the start of every run).
param([string]$OutDir = (Join-Path $env:TEMP 'siru-voice-isolation\clips'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

# 16 kHz, 16-bit, mono PCM: what the browser decodes and the speech recogniser expects.
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice.Rate = -1
$clips = [ordered]@{
  a = 'Please add Dolo six fifty tablets to my cart.'   # patient A
  b = 'What time does the pharmacy close today?'        # patient B
}
foreach ($name in $clips.Keys) {
  $file = Join-Path $OutDir "$name.wav"
  $voice.SetOutputToWaveFile($file, $format)
  $voice.Speak($clips[$name])
  $voice.SetOutputToNull()
  Write-Host ("{0}  {1:N0} bytes  '{2}'" -f $file, (Get-Item $file).Length, $clips[$name])
}
$voice.Dispose()
