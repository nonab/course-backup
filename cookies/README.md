# Session Cookies Directory

Place your exported session cookies JSON files in this directory.

### Supported File Naming:
You can name your exported cookies using any of the following conventions:
- `<domain>_cookies.json` (e.g., `www.skool.com_cookies.json` or `skool.com_cookies.json`)
- `<domain>.json` (e.g., `skool.com.json`)
- `<platform>.json` (e.g., `skool.json` or `skool_cookies.json`)
- `cookies.json` (fallback for single-session runs)

The engine uses smart wildcard matching to automatically find and load the matching cookie file for the target platform.

> **Security Note:** All `.json` files in this directory are excluded from Git via `.gitignore` to prevent credential leakage.
