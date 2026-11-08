; bigbud NSIS hooks, included via `nsis.include` in
; scripts/lib/desktop-artifact/resources.ts.
;
; Replaces electron-builder's CHECK_APP_RUNNING, which only closes bigbud.exe.
; Leftover helpers started from the install folder made the old uninstaller fail
; with "Failed to uninstall old application files ... : 2". This hook runs in the
; new installer before the old version is uninstalled, and in the uninstaller.

!define BIGBUD_CLOSE_PROCESSES_SCRIPT "${__FILEDIR__}\closeInstalledProcesses.ps1"

!macro customCheckAppRunning
  Push $R0
  Push $R1

  InitPluginsDir
  File "/oname=$PLUGINSDIR\bigbudCloseInstalledProcesses.ps1" "${BIGBUD_CLOSE_PROCESSES_SCRIPT}"
  System::Call 'kernel32::GetCurrentProcessId() i .R0'
  System::Call 'kernel32::SetEnvironmentVariable(t "BIGBUD_NSIS_INSTDIR", t "$INSTDIR") i'
  System::Call 'kernel32::SetEnvironmentVariable(t "BIGBUD_NSIS_SELF_PID", t "$R0") i'

  ; Ask a running bigbud to close gracefully so it can stop its own helpers.
  !ifdef INSTALL_MODE_PER_ALL_USERS
    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO csv | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}"`
  !else
    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO csv | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}"`
  !endif
  Pop $R1
  ${If} $R1 == 0
    ${IfNot} ${isUpdated}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
      Quit
    ${EndIf}
    DetailPrint `Closing running "${PRODUCT_NAME}"...`
    !ifdef INSTALL_MODE_PER_ALL_USERS
      nsExec::Exec `"$SYSDIR\taskkill.exe" /im "${APP_EXECUTABLE_FILENAME}"`
    !else
      nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /im "${APP_EXECUTABLE_FILENAME}" /fi "USERNAME eq %USERNAME%"`
    !endif
    Pop $R1
  ${EndIf}

  ; Close everything still running from the install folder, not just bigbud.exe.
  ${Do}
    DetailPrint `Waiting for "${PRODUCT_NAME}" processes to close...`
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\bigbudCloseInstalledProcesses.ps1"`
    Pop $R1
    ; 3 = something is still running. Any other result (success, or PowerShell
    ; unavailable) continues; the uninstaller still retries on its own.
    ${If} $R1 != 3
    ${OrIf} ${Silent}
      ${ExitDo}
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" IDRETRY +2
    Quit
  ${Loop}

  Pop $R1
  Pop $R0
!macroend
