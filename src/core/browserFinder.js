const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer');

/**
 * Windows: Queries "App Paths" in the Registry (the exact mechanism Windows Run / Win+R uses).
 * @param {string} exeName - e.g. 'msedge.exe', 'chrome.exe'
 * @returns {string|null}
 */
function findWindowsBrowser(exeName) {
    if (process.platform !== 'win32') return null;

    for (const hive of ['HKLM', 'HKCU']) {
        try {
            const key = `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`;
            const stdout = execFileSync('reg.exe', ['query', key, '/ve'], {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'ignore'],
                windowsHide: true
            });
            const match = stdout.match(/REG_SZ\s+(.+)/i);
            if (match && match[1]) {
                const clean = match[1].trim().replace(/^["']|["']$/g, '');
                if (clean && fs.existsSync(clean)) {
                    return clean;
                }
            }
        } catch (e) {
            // Not registered in this registry hive
        }
    }

    // Windows fallback: check standard Program Files directories
    const roots = [
        process.env.PROGRAMFILES,
        process.env['PROGRAMFILES(X86)'],
        process.env.LOCALAPPDATA
    ].filter(Boolean);

    const relativeSubpaths = {
        'msedge.exe': ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
        'chrome.exe': ['Google', 'Chrome', 'Application', 'chrome.exe'],
        'brave.exe': ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe']
    };

    const sub = relativeSubpaths[exeName];
    if (sub) {
        for (const root of roots) {
            const candidate = path.join(root, ...sub);
            if (fs.existsSync(candidate)) return candidate;
        }
    }

    return null;
}

/**
 * macOS: Queries standard /Applications bundle or Spotlight CLI (`mdfind`).
 * @param {string} appName - e.g. 'Microsoft Edge', 'Google Chrome'
 * @param {string} bundleId - e.g. 'com.microsoft.edgemac', 'com.google.Chrome'
 * @returns {string|null}
 */
function findMacBrowser(appName, bundleId) {
    if (process.platform !== 'darwin') return null;

    // 1. Direct standard Applications check
    const standardPaths = [
        `/Applications/${appName}.app/Contents/MacOS/${appName}`,
        `${process.env.HOME || ''}/Applications/${appName}.app/Contents/MacOS/${appName}`
    ];
    for (const p of standardPaths) {
        if (p && fs.existsSync(p)) return p;
    }

    // 2. Spotlight CLI (mdfind) if moved to a non-standard location
    try {
        const stdout = execFileSync('mdfind', [`kMDItemCFBundleIdentifier == "${bundleId}"`], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
        });
        const appPath = stdout.trim().split(/\r?\n/)[0];
        if (appPath) {
            const exePath = path.join(appPath, 'Contents', 'MacOS', appName);
            if (fs.existsSync(exePath)) return exePath;
        }
    } catch (e) { }

    return null;
}

/**
 * Linux: Queries `$PATH` using native `which`.
 * @param {string} cmdName - e.g. 'google-chrome-stable', 'microsoft-edge'
 * @returns {string|null}
 */
function findLinuxBrowser(cmdName) {
    if (process.platform !== 'linux') return null;

    try {
        const stdout = execFileSync('which', [cmdName], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
        });
        const clean = stdout.trim().split(/\r?\n/)[0];
        if (clean && fs.existsSync(clean)) return clean;
    } catch (e) { }

    return null;
}

/**
 * Returns all available Chromium browser candidates on the user's system in priority order.
 * @returns {Promise<Array<{ path: string, name: string }>>}
 */
async function getBrowserCandidates() {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const isLinux = process.platform === 'linux';
    const candidates = [];
    const seenPaths = new Set();

    const addCandidate = (p, name) => {
        if (!p) return;
        const normalized = path.resolve(p).toLowerCase();
        if (!seenPaths.has(normalized) && fs.existsSync(p)) {
            seenPaths.add(normalized);
            candidates.push({ path: p, name });
        }
    };

    // 1. Windows discovery via Registry & standard paths
    if (isWin) {
        const windowsBrowsers = [
            { exe: 'msedge.exe', name: 'Microsoft Edge' },
            { exe: 'chrome.exe', name: 'Google Chrome' },
            { exe: 'brave.exe', name: 'Brave' }
        ];
        for (const item of windowsBrowsers) {
            addCandidate(findWindowsBrowser(item.exe), item.name);
        }
    }

    // 2. macOS discovery
    if (isMac) {
        const macBrowsers = [
            { app: 'Microsoft Edge', bundleId: 'com.microsoft.edgemac' },
            { app: 'Google Chrome', bundleId: 'com.google.Chrome' },
            { app: 'Brave Browser', bundleId: 'com.brave.Browser' }
        ];
        for (const item of macBrowsers) {
            addCandidate(findMacBrowser(item.app, item.bundleId), item.app);
        }
    }

    // 3. Linux discovery
    if (isLinux) {
        const linuxBrowsers = [
            { cmd: 'microsoft-edge-stable', name: 'Microsoft Edge' },
            { cmd: 'microsoft-edge', name: 'Microsoft Edge' },
            { cmd: 'google-chrome-stable', name: 'Google Chrome' },
            { cmd: 'google-chrome', name: 'Google Chrome' },
            { cmd: 'chromium', name: 'Chromium' },
            { cmd: 'chromium-browser', name: 'Chromium' },
            { cmd: 'brave-browser', name: 'Brave' }
        ];
        for (const item of linuxBrowsers) {
            addCandidate(findLinuxBrowser(item.cmd), item.name);
        }
    }

    // 4. Puppeteer local cached browser fallback
    try {
        const defaultPath = puppeteer.executablePath();
        if (defaultPath) {
            addCandidate(defaultPath, 'Chrome for Testing (cached)');
        }
    } catch (e) { }

    return candidates;
}

/**
 * Finds an available Chromium browser on the user's system using native platform discovery.
 * Prioritizes Microsoft Edge on Windows (pre-installed on 100% of Windows 10 & 11 PCs).
 * @param {Function} [logger] - Optional logging callback
 * @returns {Promise<{ path: string, name: string }>}
 */
async function findBrowserExecutable(logger = null) {
    const candidates = await getBrowserCandidates();
    if (candidates.length > 0) {
        return candidates[0];
    }

    throw new Error('Could not find Microsoft Edge or Google Chrome on your computer. Please make sure Edge or Chrome is installed to run course migrations.');
}

module.exports = {
    findBrowserExecutable,
    getBrowserCandidates,
    findWindowsBrowser,
    findMacBrowser,
    findLinuxBrowser
};
