; NSIS 自定义脚本 — 由 electron-builder 的 nsis.include 引入（必须保留此文件并纳入 Git）
;
; 当前行为：卸载前若主程序仍存在，则执行 --clear-login-item，清除系统登录项/开机自启

!macro customUnInit
  ; 卸载前清除开机自启（文件尚未删除，exe 仍存在）
  IfFileExists "$INSTDIR\OpenClaw Desktop.exe" 0 +2
  ExecWait '"$INSTDIR\OpenClaw Desktop.exe" --clear-login-item' $0
!macroend
