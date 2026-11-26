const fs = require('fs');
const path = require('path');

/**
 * Extract clean hostname and root domain from a given URL or hostname string.
 * @param {string} rawUrl
 * @returns {{ hostname: string, rootDomain: string }}
 */
function extractDomains(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') {
        return { hostname: '', rootDomain: '' };
    }

    let urlString = rawUrl.trim();
    if (!urlString.startsWith('http://') && !urlString.startsWith('https://')) {
        urlString = 'https://' + urlString;
    }

    try {
        const parsed = new URL(urlString);
        const hostname = parsed.hostname.toLowerCase();
        // Remove leading 'www.' for root domain comparison
        const rootDomain = hostname.replace(/^www\./i, '');
        return { hostname, rootDomain };
    } catch (e) {
        const cleaned = rawUrl.toLowerCase().trim().replace(/^https?:\/\//i, '').split('/')[0];
        const rootDomain = cleaned.replace(/^www\./i, '');
        return { hostname: cleaned, rootDomain };
    }
}

/**
 * Intelligently find matching session cookies file using exact and wildcard logic.
 * Searches in:
 * 1. `cookies/` folder inside baseDir (priority)
 * 2. `baseDir` root (fallback)
 *
 * Checks in order:
 * a) Exact matches in cookies/ or root:
 *    - <hostname>_cookies.json, <hostname>.json
 *    - <rootDomain>_cookies.json, <rootDomain>.json
 * b) Wildcard match in cookies/ or root:
 *    - Any .json file containing <rootDomain> (case-insensitive, e.g. www.skool.com_cookies.json)
 * c) Platform ID match:
 *    - <platformId>_cookies.json, <platformId>.json
 * d) Generic fallback:
 *    - cookies.json
 *
 * @param {string} url - Target URL
 * @param {string} [platformId=''] - Optional platform identifier (e.g. 'skool')
 * @param {string} [baseDir=process.cwd()] - Project root directory
 * @returns {string|null} Absolute path to detected cookies file, or null
 */
function findCookieFile(url, platformId = '', baseDir = process.cwd()) {
    const { hostname, rootDomain } = extractDomains(url);
    const cleanPlatform = (platformId || '').toLowerCase().trim();

    const searchDirs = [
        path.resolve(baseDir, 'cookies'),
        path.resolve(baseDir)
    ];

    for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue;

        let files = [];
        try {
            files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json'));
        } catch (e) {
            continue;
        }

        if (files.length === 0) continue;

        // 1. Exact candidate names (highest priority)
        const exactCandidates = [];
        if (hostname) {
            exactCandidates.push(`${hostname}_cookies.json`, `${hostname}.json`);
        }
        if (rootDomain && rootDomain !== hostname) {
            exactCandidates.push(`${rootDomain}_cookies.json`, `${rootDomain}.json`);
        }

        for (const candidate of exactCandidates) {
            const found = files.find(f => f.toLowerCase() === candidate.toLowerCase());
            if (found) {
                return path.join(dir, found);
            }
        }

        // 2. Wildcard match: any file containing rootDomain (e.g. "www.skool.com_cookies.json" contains "skool.com")
        if (rootDomain && rootDomain.length > 3) {
            const wildcardFound = files.find(f => f.toLowerCase().includes(rootDomain.toLowerCase()));
            if (wildcardFound) {
                return path.join(dir, wildcardFound);
            }
        }

        // 3. Platform ID match
        if (cleanPlatform && cleanPlatform.length > 2) {
            const platformCandidates = [
                `${cleanPlatform}_cookies.json`,
                `${cleanPlatform}.json`
            ];
            for (const candidate of platformCandidates) {
                const found = files.find(f => f.toLowerCase() === candidate.toLowerCase());
                if (found) {
                    return path.join(dir, found);
                }
            }
            // Wildcard platformId (e.g. "skool-backup_cookies.json")
            const platformWildcard = files.find(f => f.toLowerCase().includes(cleanPlatform));
            if (platformWildcard) {
                return path.join(dir, platformWildcard);
            }
        }

        // 4. Generic cookies.json in this directory
        const generic = files.find(f => f.toLowerCase() === 'cookies.json');
        if (generic) {
            return path.join(dir, generic);
        }
    }

    return null;
}

/**
 * Ensure cookies directory exists and return absolute path.
 */
function getCookiesDir(baseDir = process.cwd()) {
    const dir = path.resolve(baseDir, 'cookies');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

module.exports = {
    findCookieFile,
    getCookiesDir,
    extractDomains
};
