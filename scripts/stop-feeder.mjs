// Stops any running virtual-device feeder so the integration suite can own
// COM10/COM11 (a com0com port opens exclusively).
import { execSync } from 'node:child_process';

try {
  execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -like '*virtual-device*' } | ForEach-Object { Write-Host ('stopping feeder pid ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }"`,
    { stdio: 'inherit' },
  );
} catch {
  // Nothing to stop, or PowerShell refused — the suite will fail with a
  // clear "Access denied" message if the port is genuinely held.
}
