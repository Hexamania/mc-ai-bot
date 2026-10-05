!ifndef BUILD_UNINSTALLER
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
Var AiriPortableMode
Var AiriInstallModeRadio
Var AiriPortableModeRadio

!macro customPageAfterChangeDir
  Page custom AiriModePageCreate AiriModePageLeave
!macroend

Function AiriModePageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 18u "Select whether Airi OS should be a regular Windows app or a portable folder."
  Pop $0
  ${NSD_CreateRadioButton} 0 24u 100% 24u "Install normally"
  Pop $AiriInstallModeRadio
  ${NSD_CreateLabel} 18u 49u 95% 34u "Creates Windows shortcuts and an uninstall entry. Settings are stored in your Windows profile."
  Pop $0

  ${NSD_CreateRadioButton} 0 95u 100% 24u "Portable mode"
  Pop $AiriPortableModeRadio
  ${NSD_CreateLabel} 18u 120u 95% 40u "Keeps the app in the selected folder and stores settings and memory beside Airi OS.exe. No shortcuts or Windows uninstall entry are created."
  Pop $0

  ${NSD_Check} $AiriInstallModeRadio
  nsDialogs::Show
FunctionEnd

Function AiriModePageLeave
  ${NSD_GetState} $AiriPortableModeRadio $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $AiriPortableMode "true"
  ${Else}
    StrCpy $AiriPortableMode "false"
  ${EndIf}
FunctionEnd

!macro customInstall
  ${If} $AiriPortableMode == "true"
    FileOpen $0 "$INSTDIR\portable.txt" w
    FileWrite $0 "Airi OS portable mode$\r$\n"
    FileClose $0

    Delete "$newDesktopLink"
    Delete "$newStartMenuLink"
    StrCpy $launchLink "$appExe"
    !ifdef MENU_FILENAME
      RMDir "$SMPROGRAMS\${MENU_FILENAME}"
    !endif

    DeleteRegKey SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}"
    DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey HKLM "${INSTALL_REGISTRY_KEY}"
    DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
    Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  ${Else}
    Delete "$INSTDIR\portable.txt"
  ${EndIf}
!macroend
!endif
