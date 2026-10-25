@echo off
REM Provisions the com0com virtual pair COM10 <-> COM11 used by the smoke
REM scripts and the integration tests. Run ELEVATED (driver + setupc need
REM admin). Prerequisite: com0com 3.0.0.0 installed from SourceForge.
REM
REM Known quirks this script encodes (each cost a debugging round):
REM  - The silent installer (/S) copies files but does NOT register the
REM    driver: the INF/CAT/SYS must be copied into System32 first.
REM  - setupc with no arguments drops into an interactive prompt and hangs
REM    scripts — always pass a command; never pipe stdin.
REM  - setupc talks to the driver directly, so it fails unelevated.
REM Verify afterwards: "npm run smoke:check" in the repo root.
setlocal
set LOG=%TEMP%\com0com-setup.log
set "SRC=C:\Program Files (x86)\com0com"
set "SETUPC=%SRC%\setupc.exe"

echo === com0com setup started %DATE% %TIME% === > "%LOG%"

if not exist "%SETUPC%" (
  echo ERROR: %SETUPC% not found — install com0com first. >> "%LOG%"
  type "%LOG%"
  exit /b 1
)

echo === copy driver files into System32 === >> "%LOG%"
copy /Y "%SRC%\*.inf" "%SystemRoot%\System32\" >> "%LOG%" 2>&1
copy /Y "%SRC%\*.cat" "%SystemRoot%\System32\" >> "%LOG%" 2>&1
copy /Y "%SRC%\*.sys" "%SystemRoot%\System32\drivers\" >> "%LOG%" 2>&1

echo === install pair 0 as COM10/COM11 === >> "%LOG%"
"%SETUPC%" install 0 PortName=COM10 PortName=COM11 >> "%LOG%" 2>&1

echo === driver service state === >> "%LOG%"
sc query com0com >> "%LOG%" 2>&1

echo === final pair list === >> "%LOG%"
"%SETUPC%" list >> "%LOG%" 2>&1

echo === SERIALCOMM registry === >> "%LOG%"
reg query HKLM\HARDWARE\DEVICEMAP\SERIALCOMM >> "%LOG%" 2>&1

type "%LOG%"
echo Done. Details in %LOG%
endlocal
