/**
 * Shared constants — main and renderer.
 * Path layout matches upstream OpenClaw conventions.
 */

/** Default gateway listen port */
export const DEFAULT_GATEWAY_PORT = 18789

/** OpenClaw state directory under %USERPROFILE% */
export const OPENCLAW_USER_DIR = '.openclaw'

/** Legacy shell config directory name (under %APPDATA%); keep stable for upgrades. */
export const APP_NAME = 'OpenClaw Desktop'

/** User-visible branded product name */
export const DISPLAY_APP_NAME = '涵旭科技-奥影Claw专业剪辑版'

/** Main OpenClaw config filename */
export const OPENCLAW_CONFIG_FILE = 'openclaw.json'

/** Shell config file relative to app.getPath('userData') */
export const SHELL_CONFIG_FILE = 'config.json'
