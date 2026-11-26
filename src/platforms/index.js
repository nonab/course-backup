const fs = require('fs');
const path = require('path');
const Module = require('module');

// Alias resolver for external platform files placed in the .exe folder
const coreDir = path.resolve(__dirname, '../core');
const appNodeModules = path.resolve(__dirname, '../../node_modules');
const origResolve = Module._resolveFilename;

Module._resolveFilename = function(request, parent, isMain, options) {
    const match = request.match(/(?:core\/)?([a-zA-Z]+)(?:\.js)?$/);
    if (match) {
        const candidate = path.join(coreDir, `${match[1]}.js`);
        if (fs.existsSync(candidate)) return candidate;
    }
    try {
        return origResolve.call(this, request, parent, isMain, options);
    } catch (err) {
        if (appNodeModules && fs.existsSync(path.join(appNodeModules, request))) {
            return path.join(appNodeModules, request);
        }
        throw err;
    }
};

/**
 * PlatformRegistry (Autoloader)
 * Automatically discovers all built-in and external platform*.js files placed in the executable directory.
 */
class PlatformRegistry {
    constructor() {
        this.platforms = new Map();
        this.loaded = false;
    }

    load() {
        if (this.loaded) return;

        const scanDirs = Array.from(new Set([
            __dirname,
            process.env.PORTABLE_EXECUTABLE_DIR,
            process.execPath ? path.dirname(process.execPath) : null,
            process.cwd()
        ].filter(d => d && fs.existsSync(d))));

        for (const dir of scanDirs) {
            const isInternal = path.resolve(dir) === path.resolve(__dirname);
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.startsWith('.') && !f.startsWith('_'));

            for (const file of files) {
                if (['index.js', 'templatePlatformFunctions.js', 'courseBackup.js'].includes(file)) continue;
                if (!isInternal && !/^platform/i.test(file)) continue;

                try {
                    const platformModule = require(path.join(dir, file));
                    const fallbackId = file.replace(/^platform/i, '').replace(/Functions\.js$/i, '').replace(/\.js$/i, '').toLowerCase();
                    const id = (platformModule.id || fallbackId).toLowerCase();
                    const name = platformModule.name || (fallbackId.charAt(0).toUpperCase() + fallbackId.slice(1));

                    this.platforms.set(id, {
                        id,
                        name,
                        isWordPress: !!platformModule.isWordPress,
                        domains: platformModule.domains || [],
                        urlPatterns: platformModule.urlPatterns || [],
                        detectionKeywords: platformModule.detectionKeywords || [],
                        authMethods: platformModule.authMethods || ['cookies', 'credentials'],
                        login: platformModule.login || (async () => {}),
                        getCourses: platformModule.getCourses || (async () => []),
                        getStructure: platformModule.getStructure || (async () => ({})),
                        scrapLessonData: platformModule.scrapLessonData || (async (p, s) => s),
                        sanitizeOutputDir: platformModule.sanitizeOutputDir || null,
                        filename: file,
                        raw: platformModule
                    });
                } catch (err) {
                    console.warn(`[Autoloader] Warning: Failed to load ${file} from ${dir}: ${err.message}`);
                }
            }
        }

        this.loaded = true;
    }

    getAll() {
        this.load();
        return Array.from(this.platforms.values());
    }

    get(idOrAlias) {
        if (!idOrAlias) return null;
        this.load();
        return this.platforms.get(idOrAlias.toLowerCase().trim()) || null;
    }

    match(url, pageContent = '') {
        if (!url) return null;
        this.load();
        const urlLower = url.toLowerCase();

        for (const platform of this.platforms.values()) {
            if (platform.domains?.some(d => urlLower.includes(d.toLowerCase()))) return platform;
            if (platform.urlPatterns?.some(p => p instanceof RegExp ? p.test(url) : urlLower.includes(String(p).toLowerCase()))) return platform;
        }

        if (pageContent && typeof pageContent === 'string') {
            for (const platform of this.platforms.values()) {
                if (platform.detectionKeywords?.some(kw => pageContent.includes(kw))) return platform;
            }
        }

        return null;
    }
}

module.exports = new PlatformRegistry();
