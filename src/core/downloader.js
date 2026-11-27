const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, execSync } = require('child_process');
const axios = require('axios');
const contentDisposition = require('content-disposition');

// MIME type to file extension mapping
const MIME_EXTENSION_MAP = {
    'application/pdf': '.pdf',
    'application/x-mobipocket-ebook': '.mobi',
    'application/x-mobi': '.mobi',
    'application/epub+zip': '.epub',
    'application/zip': '.zip',
    'application/x-zip-compressed': '.zip',
    'application/x-rar-compressed': '.rar',
    'application/vnd.rar': '.rar',
    'application/x-7z-compressed': '.7z',
    'video/mp4': '.mp4',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'text/plain': '.txt',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx'
};

/**
 * Detects whether an existing or downloaded file is an HTML page (such as a login redirect)
 * erroneously saved with a binary extension (.pdf, .mobi, .epub, .zip, etc.).
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isCorruptedHtmlFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    try {
        const stats = fs.statSync(filePath);
        if (stats.size === 0) return true;

        const ext = path.extname(filePath).toLowerCase();
        const binaryExtensions = [
            '.pdf', '.zip', '.rar', '.7z', '.mobi', '.epub',
            '.mp4', '.mp3', '.wav', '.docx', '.xlsx', '.pptx',
            '.avi', '.mkv', '.tar', '.gz'
        ];
        if (!binaryExtensions.includes(ext)) {
            return false;
        }

        const fd = fs.openSync(filePath, 'r');
        const readLen = Math.min(stats.size, 2048);
        const buffer = Buffer.alloc(readLen);
        fs.readSync(fd, buffer, 0, readLen, 0);
        fs.closeSync(fd);

        const sample = buffer.toString('utf8').trim().toLowerCase();
        if (
            sample.startsWith('<!doctype html') ||
            sample.startsWith('<html') ||
            sample.includes('<head') ||
            sample.includes('meta property="og:url"') ||
            sample.includes('/login') ||
            sample.includes('/sign_in') ||
            sample.includes('/users/sign_in') ||
            sample.includes('<title>logowanie') ||
            sample.includes('<title>login') ||
            sample.includes('<title>sign in')
        ) {
            return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

// Set of active child processes spawned by downloader
const activeProcesses = new Set();

/**
 * Forcefully terminates a process and all of its child processes (process tree).
 * On Windows uses taskkill /pid PID /T /F
 * On POSIX uses SIGKILL on process group or PID
 *
 * @param {import('child_process').ChildProcess|number} procOrPid
 */
function killProcessTree(procOrPid) {
    const pid = typeof procOrPid === 'number' ? procOrPid : procOrPid?.pid;
    if (!pid) return;

    if (process.platform === 'win32') {
        try {
            execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
        } catch (e) { }
    } else {
        try {
            process.kill(-pid, 'SIGKILL');
        } catch (e) {
            try {
                if (typeof procOrPid?.kill === 'function') {
                    procOrPid.kill('SIGKILL');
                } else {
                    process.kill(pid, 'SIGKILL');
                }
            } catch (err) { }
        }
    }
}

/**
 * Registers an active child process so it can be terminated on cancellation or app exit.
 * @param {import('child_process').ChildProcess} proc
 */
function registerActiveProcess(proc) {
    if (!proc || !proc.pid) return;
    activeProcesses.add(proc);
    const cleanup = () => activeProcesses.delete(proc);
    proc.once('close', cleanup);
    proc.once('exit', cleanup);
    proc.once('error', cleanup);
}

/**
 * Kills all currently active child processes spawned by the downloader.
 */
function killAllDownloadProcesses() {
    for (const proc of activeProcesses) {
        try {
            proc.isKilledByApp = true;
            killProcessTree(proc);
        } catch (e) { }
    }
    activeProcesses.clear();
}

/**
 * Checks if an executable tool is available in the local bin/ folder or globally in PATH.
 * @param {string} name e.g. 'yt-dlp' or 'ffmpeg'
 * @returns {Promise<{ found: boolean, path: string|null, source: 'local'|'system'|null }>}
 */
async function checkTool(name) {
    const isWin = process.platform === 'win32';
    const exeName = isWin ? `${name}.exe` : name;

    // 1. Check local bin/ folder (both relative to cwd and project root)
    const localCandidates = [
        path.resolve(process.cwd(), 'bin', exeName),
        path.resolve(__dirname, '../../bin', exeName)
    ];

    for (const p of localCandidates) {
        if (fs.existsSync(p)) {
            return { found: true, path: p, source: 'local' };
        }
    }

    // 2. Check system PATH via where.exe (Windows) or which (Unix)
    return new Promise((resolve) => {
        const checkCmd = isWin
            ? (process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'where.exe') : 'where.exe')
            : 'which';
        const proc = spawn(checkCmd, [name], { shell: false });
        let stdout = '';
        proc.stdout.on('data', d => { stdout += d; });
        proc.on('close', (code) => {
            if (code === 0 && stdout.trim()) {
                const detectedPath = stdout.trim().split(/\r?\n/)[0];
                resolve({ found: true, path: detectedPath, source: 'system' });
            } else {
                resolve({ found: false, path: null, source: null });
            }
        });
        proc.on('error', () => resolve({ found: false, path: null, source: null }));
    });
}

/**
 * Checks whether both yt-dlp and ffmpeg are available for media downloading.
 * @returns {Promise<{ ytdlp: object, ffmpeg: object, allOk: boolean }>}
 */
async function checkMediaDependencies() {
    const ytdlp = await checkTool('yt-dlp');
    const ffmpeg = await checkTool('ffmpeg');
    return {
        ytdlp,
        ffmpeg,
        allOk: ytdlp.found && ffmpeg.found
    };
}

/**
 * Checks if yt-dlp is available either in a local bin/ folder or globally in PATH.
 * @returns {Promise<{ available: boolean, executable: string }>}
 */
async function checkYtDlp() {
    const res = await checkTool('yt-dlp');
    return {
        available: res.found,
        executable: res.found ? (res.source === 'local' ? res.path : 'yt-dlp') : 'yt-dlp'
    };
}

/**
 * Clean and sanitize a filename for disk storage.
 * @param {string} str
 * @returns {string}
 */
function cleanFileName(str) {
    if (!str || typeof str !== 'string') return 'file';
    return str
        .replace(/[<>:"/\\|?*\x00-\x1F\x7F]/g, '_')
        .replace(/[^\w\s\p{L}\p{N}._-]/gu, '_')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Saves HTML lesson content directly to the course root directory with a clean standalone viewer template.
 * @param {string} html
 * @param {string} title
 * @param {string} courseDir
 * @returns {string} Target HTML file path
 */
function saveLessonHtml(html, title, courseDir) {
    if (!html || typeof html !== 'string' || !html.trim()) return null;

    if (!fs.existsSync(courseDir)) {
        fs.mkdirSync(courseDir, { recursive: true });
    }

    const safeTitle = cleanFileName(title);
    const targetPath = path.join(courseDir, `${safeTitle}.html`);

    // Migrate/clean up legacy html subfolder if present
    const legacyPath = path.join(courseDir, 'html', `${safeTitle}.html`);
    if (fs.existsSync(legacyPath)) {
        try { fs.unlinkSync(legacyPath); } catch (e) { }
    }
    const legacyDir = path.join(courseDir, 'html');
    if (fs.existsSync(legacyDir)) {
        try {
            const files = fs.readdirSync(legacyDir);
            if (files.length === 0) fs.rmdirSync(legacyDir);
        } catch (e) { }
    }

    const fullDocument = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #1e293b;
      background: #f8fafc;
      margin: 0;
      padding: 2rem;
    }
    .container {
      max-width: 860px;
      margin: 0 auto;
      background: #ffffff;
      padding: 2.5rem;
      border-radius: 12px;
      box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
    }
    h1 {
      font-size: 1.75rem;
      color: #0f172a;
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 0.75rem;
      margin-top: 0;
    }
    img {
      max-width: 100%;
      height: auto;
      border-radius: 8px;
    }
    a {
      color: #4f46e5;
      text-decoration: underline;
    }
    pre, code {
      background: #f1f5f9;
      border-radius: 4px;
      padding: 0.2rem 0.4rem;
      font-size: 0.9em;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${safeTitle}</h1>
    <div class="lesson-content">
      ${html}
    </div>
  </div>
</body>
</html>`;

    fs.writeFileSync(targetPath, fullDocument, 'utf8');
    return targetPath;
}

/**
 * Downloads a material / attachment file via HTTP stream with session authentication and resume check.
 * @param {string} fileUrl
 * @param {string} fileName
 * @param {string} courseDir
 * @param {object} [options]
 * @param {string} [options.cookies] Cookie header string
 * @param {string} [options.referer] Referer URL
 * @param {string} [options.userAgent] Browser user agent
 * @param {object} [options.page] Puppeteer page instance
 * @param {Function} [options.onLog] Log callback
 * @returns {Promise<string>} Downloaded file path
 */
async function downloadMaterial(fileUrl, fileName, courseDir, options = {}) {
    if (!fileUrl) return null;

    const materialsDir = options.destinationDir || path.join(courseDir, 'materials');
    if (!fs.existsSync(materialsDir)) {
        fs.mkdirSync(materialsDir, { recursive: true });
    }

    // 1. Initial name resolution
    let resolvedName = cleanFileName(fileName || '');
    let extension = path.extname(resolvedName).toLowerCase();

    // Check URL pathname for extension if not found in resolvedName
    if (!extension) {
        try {
            const parsed = new URL(fileUrl);
            const urlExt = path.extname(parsed.pathname).toLowerCase();
            if (urlExt && urlExt.length <= 6) {
                extension = urlExt;
            }
        } catch (e) { }
    }

    // Fallback regex matching in fileUrl
    if (!extension) {
        const extMatch = fileUrl.match(/\.(pdf|zip|rar|7z|docx?|xlsx?|pptx?|mp3|wav|png|jpe?g|mobi|epub)/i);
        if (extMatch) {
            extension = `.${extMatch[1].toLowerCase()}`;
        }
    }

    if (!resolvedName) {
        try {
            resolvedName = cleanFileName(path.basename(new URL(fileUrl).pathname));
        } catch (e) {
            resolvedName = 'material';
        }
    }

    if (extension && !resolvedName.toLowerCase().endsWith(extension)) {
        resolvedName += extension;
    }

    let targetPath = path.join(materialsDir, resolvedName);

    // 2. Skip if already downloaded and not corrupt
    if (fs.existsSync(targetPath)) {
        if (isCorruptedHtmlFile(targetPath)) {
            try { fs.unlinkSync(targetPath); } catch (e) { }
        } else if (fs.statSync(targetPath).size > 0) {
            return targetPath;
        }
    }

    // 3. Resolve session cookies
    let cookieHeader = options.cookies || '';
    if (!cookieHeader && options.page && !options.page.isClosed()) {
        try {
            const pageCookies = await options.page.cookies();
            cookieHeader = pageCookies.map(c => `${c.name}=${c.value}`).join('; ');
        } catch (e) { }
    }

    // Resolve User-Agent
    let userAgent = options.userAgent || '';
    if (!userAgent && options.page && !options.page.isClosed()) {
        try {
            userAgent = await options.page.evaluate(() => navigator.userAgent);
        } catch (e) { }
    }
    if (!userAgent) {
        userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    }

    const headers = {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
        ...(options.referer ? { 'Referer': options.referer } : {}),
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
        ...(options.headers || {})
    };

    // 4. Request the file
    let response;
    try {
        response = await axios({
            url: fileUrl,
            method: 'GET',
            responseType: 'stream',
            timeout: 60000,
            headers,
            maxRedirects: 10,
            validateStatus: (status) => status >= 200 && status < 400
        });
    } catch (err) {
        throw new Error(`Failed to initiate material download for "${resolvedName}": ${err.message}`);
    }

    // 5. Inspect response headers & URL for login redirects / HTML errors
    const finalUrl = response.request?.res?.responseUrl || response.config?.url || '';
    const contentType = (response.headers['content-type'] || '').toLowerCase();
    const finalPathLower = finalUrl.toLowerCase();

    if (
        finalPathLower.includes('/login') ||
        finalPathLower.includes('/sign_in') ||
        finalPathLower.includes('/users/sign_in')
    ) {
        try { response.data.destroy(); } catch (e) { }
        throw new Error(`Authentication required for "${resolvedName}": redirected to login page (${finalUrl})`);
    }

    // 6. Refine extension and filename from Content-Disposition if present
    const dispositionHeader = response.headers['content-disposition'];
    if (dispositionHeader) {
        try {
            const parsedDisp = contentDisposition.parse(dispositionHeader);
            const dispName = parsedDisp.parameters?.filename;
            if (dispName) {
                const cleanedDisp = cleanFileName(dispName);
                if (cleanedDisp) {
                    resolvedName = cleanedDisp;
                    extension = path.extname(cleanedDisp).toLowerCase();
                    targetPath = path.join(materialsDir, resolvedName);
                }
            }
        } catch (e) { }
    }

    // 7. Refine extension from Content-Type if still missing
    if (!extension || !path.extname(resolvedName)) {
        const mime = contentType.split(';')[0].trim();
        const mappedExt = MIME_EXTENSION_MAP[mime];
        if (mappedExt) {
            extension = mappedExt;
            if (!resolvedName.toLowerCase().endsWith(extension)) {
                resolvedName += extension;
                targetPath = path.join(materialsDir, resolvedName);
            }
        }
    }

    // Verify content type is not HTML when expecting a binary file
    const isBinaryFile = /\.(pdf|zip|rar|7z|docx?|xlsx?|pptx?|mp3|wav|mp4|mobi|epub)$/i.test(targetPath);
    if (isBinaryFile && contentType.includes('text/html')) {
        try { response.data.destroy(); } catch (e) { }
        throw new Error(`Expected binary file for "${resolvedName}", but server returned HTML (Content-Type: ${contentType}). Likely an unauthorized or error page.`);
    }

    // Re-check targetPath now that resolvedName is finalized
    if (fs.existsSync(targetPath)) {
        if (isCorruptedHtmlFile(targetPath)) {
            try { fs.unlinkSync(targetPath); } catch (e) { }
        } else if (fs.statSync(targetPath).size > 0) {
            try { response.data.destroy(); } catch (e) { }
            return targetPath;
        }
    }

    // 8. Stream download to a temporary file
    const tempPath = targetPath + '.downloading';
    const writer = fs.createWriteStream(tempPath);

    try {
        await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // 9. Post-download verification
        const stat = fs.statSync(tempPath);
        if (stat.size === 0) {
            try { fs.unlinkSync(tempPath); } catch (e) { }
            throw new Error(`Downloaded file "${resolvedName}" is empty (0 bytes).`);
        }

        if (isCorruptedHtmlFile(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch (e) { }
            throw new Error(`Downloaded file "${resolvedName}" contains HTML content instead of binary data (authentication failed).`);
        }

        // Rename atomically to targetPath
        if (fs.existsSync(targetPath)) {
            try { fs.unlinkSync(targetPath); } catch (e) { }
        }
        fs.renameSync(tempPath, targetPath);

        return targetPath;
    } catch (err) {
        writer.close();
        if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch (e) { }
        }
        throw new Error(`Failed to download material "${resolvedName}": ${err.message}`);
    }
}

/**
 * Downloads a video using yt-dlp or direct stream into the videos folder.
 * @param {string} videoUrl
 * @param {string} title
 * @param {string} courseDir
 * @param {object} [options]
 * @param {Function} [options.onLog]
 * @returns {Promise<string>} Downloaded video path
 */
async function downloadVideoInline(videoUrl, title, courseDir, options = {}) {
    if (!videoUrl) return null;

    if (!fs.existsSync(courseDir)) {
        fs.mkdirSync(courseDir, { recursive: true });
    }

    const safeTitle = cleanFileName(title);
    const isAudio = /\.(mp3|m4a|wav)(?:[?#]|$)/i.test(videoUrl);
    const mediaExt = isAudio ? (videoUrl.match(/\.(mp3|m4a|wav)/i)?.[1]?.toLowerCase() || 'mp3') : 'mp4';
    const targetFile = path.join(courseDir, `${safeTitle}.${mediaExt}`);

    // Migrate/clean up legacy videos subfolder if present
    const legacyFile = path.join(courseDir, 'videos', `${safeTitle}.${mediaExt}`);
    if (fs.existsSync(legacyFile) && !fs.existsSync(targetFile)) {
        try {
            fs.renameSync(legacyFile, targetFile);
        } catch (e) { }
    }
    const legacyDir = path.join(courseDir, 'videos');
    if (fs.existsSync(legacyDir)) {
        try {
            const files = fs.readdirSync(legacyDir);
            if (files.length === 0) fs.rmdirSync(legacyDir);
        } catch (e) { }
    }

    if (fs.existsSync(targetFile) && fs.statSync(targetFile).size > 1024) {
        if (options.onLog) options.onLog(`[Media Cached] ${safeTitle}.${mediaExt} already exists. Skipping.`);
        return targetFile;
    }

    // Direct MP4 / Audio download without yt-dlp if it's a direct file URL
    const isDirectMedia = /\.(mp4|mp3|m4a|wav)(\?|$)/i.test(videoUrl) && !videoUrl.includes('m3u8') && !videoUrl.includes('vimeo') && !videoUrl.includes('hotmart');

    if (isDirectMedia) {
        const typeLabel = isAudio ? 'audio' : 'MP4';
        if (options.onLog) options.onLog(`[Direct Stream] Downloading ${typeLabel} directly: ${safeTitle}.${mediaExt}...`);
        return await downloadMaterial(videoUrl, `${safeTitle}.${mediaExt}`, courseDir, {
            destinationDir: courseDir,
            headers: options.referer ? { Referer: options.referer } : undefined
        });
    }

    // Use yt-dlp for HLS, Hotmart, Wistia, Vimeo, YouTube
    const { available, executable } = await checkYtDlp();
    if (!available) {
        throw new Error(`yt-dlp is required to download streams (${videoUrl}). Please install yt-dlp or place yt-dlp.exe in bin/.`);
    }

    if (options.onLog) options.onLog(`[yt-dlp] Downloading stream for "${safeTitle}"...`);

    const args = [
        '--newline',
        '--no-warnings',
        '--no-update',
        '--no-playlist',
        '-S', 'ext:mp4',
        videoUrl,
        '-o', targetFile
    ];

    if (options.referer) {
        args.push('--referer', options.referer);
    }

    return new Promise((resolve, reject) => {
        const proc = spawn(executable, args, { shell: true });
        registerActiveProcess(proc);

        proc.stdout.on('data', (chunk) => {
            const str = chunk.toString().trim();
            if (str && options.onLog) {
                // Filter out verbose output, capture progress percentages
                const progressMatch = str.match(/\[download\]\s+(\d+\.?\d*%).*/);
                if (progressMatch) {
                    options.onLog(`[Video Download] ${safeTitle}: ${progressMatch[0]}`);
                } else if (str.startsWith('[download]') || str.startsWith('[hlsnative]')) {
                    options.onLog(str);
                }
            }
        });

        proc.stderr.on('data', (chunk) => {
            const errStr = chunk.toString().trim();
            if (errStr && !errStr.includes('WARNING') && options.onLog) {
                options.onLog(`[yt-dlp notice] ${errStr}`);
            }
        });

        proc.on('close', (code) => {
            if (proc.isKilledByApp) {
                return reject(new Error('Download cancelled'));
            }
            if (code === 0) {
                resolve(targetFile);
            } else {
                reject(new Error(`yt-dlp exited with error code ${code}`));
            }
        });

        proc.on('error', (err) => reject(err));
    });
}

/**
 * Runs a generated batch/shell download script with clean progress parsing and throttling.
 * Formats raw curl / yt-dlp output into clean milestone logs, updates overall progress,
 * and updates the top status bar.
 *
 * @param {string} scriptPath
 * @param {object} [options]
 * @param {Function} [options.onLog] (message, type = 'info') => void
 * @param {Function} [options.onProgress] (percent: number) => void
 * @param {Function} [options.onStatus] (state: string, text: string) => void
 * @returns {Promise<void>}
 */
function runBatchDownload(scriptPath, options = {}) {
    return new Promise((resolve, reject) => {
        try {
            if (fs.existsSync(scriptPath)) {
                scriptPath = fs.realpathSync.native(scriptPath);
            }
        } catch (e) { }

        if (!fs.existsSync(scriptPath)) {
            return reject(new Error(`Script file not found: ${scriptPath}`));
        }

        const scriptDir = path.dirname(scriptPath);
        const scriptName = path.basename(scriptPath);

        // Count download commands in the script to calculate multi-video progress
        let totalVideos = 1;
        let hasExplicitBackupItems = false;
        try {
            const lines = fs.readFileSync(scriptPath, 'utf8').split(/\r?\n/);
            const itemLines = lines.filter(l => /^\s*echo\s+\[backup-item\]/i.test(l));
            if (itemLines.length > 0) {
                totalVideos = itemLines.length;
                hasExplicitBackupItems = true;
            } else {
                const dlCommands = lines.filter(l => /^\s*(curl|yt-dlp)\b/i.test(l));
                if (dlCommands.length > 0) totalVideos = dlCommands.length;
            }
        } catch (e) { }

        const isWin = process.platform === 'win32';
        const cmd = isWin
            ? (process.env.ComSpec || process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe')
            : (process.env.SHELL || '/bin/bash');
        const args = isWin ? ['/d', '/c', scriptPath] : [scriptPath];

        if (options.onLog) {
            options.onLog(`[Batch Downloader] Starting download for ${totalVideos} video(s)...`, 'info');
        }
        if (options.onProgress) {
            options.onProgress(0);
        }
        if (options.onStatus) {
            options.onStatus('downloading', 'Downloading Videos...');
        }

        const binCandidates = [
            path.resolve(process.cwd(), 'bin'),
            path.resolve(__dirname, '../../bin')
        ];
        const existingBin = binCandidates.find(b => fs.existsSync(b));
        const env = { ...process.env };
        if (existingBin) {
            const sep = isWin ? ';' : ':';
            const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || (isWin ? 'Path' : 'PATH');
            const currentPath = env[pathKey] || '';
            env[pathKey] = `${existingBin}${sep}${currentPath}`;
            if (isWin) {
                env.PATH = env[pathKey];
                env.Path = env[pathKey];
            }
        }

        const proc = spawn(cmd, args, { cwd: scriptDir, shell: false, env });
        registerActiveProcess(proc);

        let currentVideoIndex = 0;
        let currentFileName = '';
        let lastReportedMilestone = -1;
        let lastLogTime = 0;

        const handleLine = (rawLine) => {
            const line = rawLine.trim();
            if (!line) return;

            // 0. Explicit backup item marker (from generated scripts)
            const itemMatch = line.match(/\[backup-item\]\s+(.+)$/i);
            if (itemMatch) {
                const detectedName = path.basename(itemMatch[1].trim()).replace(/\.(mp4|mp3|m4a|webm|mkv|part)$/i, '');
                if (detectedName !== currentFileName) {
                    currentVideoIndex++;
                    currentFileName = detectedName;
                    lastReportedMilestone = -1;
                    const fileLabel = currentFileName ? `: ${currentFileName}` : '';
                    if (options.onLog) {
                        const displayIdx = Math.min(currentVideoIndex, totalVideos);
                        options.onLog(`[Video ${displayIdx}/${totalVideos}] Started downloading${fileLabel}`, 'info');
                    }
                }
                return;
            }

            // 1. Detect starting new curl command (only increments if script has NO [backup-item] lines)
            const curlMatch = line.match(/curl\b.*?-[oO]\s+["']?(?:videos[\\/]|audio[\\/])?([^"'\r\n]+?)["']?(?:\s+--|\s*$)/i);
            if (curlMatch) {
                const detectedName = path.basename(curlMatch[1].trim()).replace(/\.(mp4|mp3|m4a|webm|mkv|part)$/i, '');
                if (!hasExplicitBackupItems && detectedName !== currentFileName) {
                    currentVideoIndex++;
                    currentFileName = detectedName;
                    lastReportedMilestone = -1;
                    const fileLabel = currentFileName ? `: ${currentFileName}` : '';
                    if (options.onLog) {
                        const displayIdx = Math.min(currentVideoIndex, totalVideos);
                        options.onLog(`[Video ${displayIdx}/${totalVideos}] Started downloading${fileLabel}`, 'info');
                    }
                } else if (!currentFileName) {
                    currentFileName = detectedName;
                }
                return;
            }

            // 2. yt-dlp destination detection (only increments if script has NO [backup-item] lines)
            const ytDestMatch = line.match(/\[download\]\s+Destination:\s+(?:videos[\\/]|audio[\\/])?([^\r\n]+)/i);
            if (ytDestMatch) {
                const detectedName = path.basename(ytDestMatch[1].trim()).replace(/\.(mp4|mp3|m4a|webm|mkv|part)$/i, '');
                if (!hasExplicitBackupItems && detectedName !== currentFileName) {
                    currentVideoIndex++;
                    currentFileName = detectedName;
                    lastReportedMilestone = -1;
                    const fileLabel = currentFileName ? `: ${currentFileName}` : '';
                    if (options.onLog) {
                        const displayIdx = Math.min(currentVideoIndex, totalVideos);
                        options.onLog(`[Video ${displayIdx}/${totalVideos}] Started downloading stream${fileLabel}`, 'info');
                    }
                } else if (!currentFileName) {
                    currentFileName = detectedName;
                }
                return;
            }

            // Ignore shell noise (chcp, mkdir, command prompt echoes)
            if (/^(chcp|mkdir|A subdirectory|cd\b|[A-Z]:\\.*>)/i.test(line)) {
                return;
            }
            if (/% Total|Dload\s+Upload|Time\s+Total/i.test(line)) {
                return;
            }

            // 2. Parse curl progress line
            // e.g. "13 419M 13 54.8M 0 0 3296k 0 0:02:10 0:00:17 0:01:53 3827k"
            const tokens = line.split(/\s+/);
            if (tokens.length >= 10 && /^\d+$/.test(tokens[0]) && /^\d+[kMGT]?$/i.test(tokens[1])) {
                const singlePercent = parseInt(tokens[0], 10);
                const totalSize = tokens[1];
                const downloadedSize = tokens[3];
                const speed = tokens[tokens.length - 1];
                const eta = tokens[10] || tokens[9] || '';

                const videoIdx = Math.min(totalVideos, Math.max(1, currentVideoIndex));
                const overallFraction = ((videoIdx - 1) + (singlePercent / 100)) / totalVideos;
                const overallPercent = Math.min(99, Math.round(overallFraction * 100));

                if (options.onProgress) {
                    options.onProgress(overallPercent);
                }

                // Throttle log output to every 25% or completion
                const milestone = Math.floor(singlePercent / 25) * 25;
                const now = Date.now();
                if (milestone > 0 && milestone !== lastReportedMilestone && (now - lastLogTime > 4000 || milestone === 100)) {
                    lastReportedMilestone = milestone;
                    lastLogTime = now;
                    const nameLabel = currentFileName ? ` "${currentFileName}"` : '';
                    if (singlePercent >= 100) {
                        if (options.onLog) options.onLog(`[Video ${videoIdx}/${totalVideos}] ✔ Downloaded 100% of${nameLabel} (${totalSize})`, 'success');
                    } else {
                        if (options.onLog) options.onLog(`[Video ${videoIdx}/${totalVideos}] Downloaded ${singlePercent}% of${nameLabel} (${downloadedSize}/${totalSize}) at ${speed}/s`, 'info');
                    }
                }
                return;
            }

            // 3. Parse yt-dlp progress line
            // e.g. "[download]  25.4% of ~ 419.00MiB at    4.50MiB/s ETA 01:20"
            const ytMatch = line.match(/\[download\]\s+(\d+\.?\d*)%\s+of\s+~?\s*([0-9.]+[kMGTP]iB)\s+at\s+([0-9.]+[kMGTP]iB\/s)\s+ETA\s+([0-9:]+)/i);
            if (ytMatch) {
                const singlePercent = Math.round(parseFloat(ytMatch[1]));
                const totalSize = ytMatch[2];
                const speed = ytMatch[3];
                const eta = ytMatch[4];

                const videoIdx = Math.min(totalVideos, Math.max(1, currentVideoIndex));
                const overallFraction = ((videoIdx - 1) + (singlePercent / 100)) / totalVideos;
                const overallPercent = Math.min(99, Math.round(overallFraction * 100));

                if (options.onProgress) {
                    options.onProgress(overallPercent);
                }

                const milestone = Math.floor(singlePercent / 25) * 25;
                const now = Date.now();
                if (milestone > 0 && milestone !== lastReportedMilestone && (now - lastLogTime > 4000 || milestone === 100)) {
                    lastReportedMilestone = milestone;
                    lastLogTime = now;
                    const nameLabel = currentFileName ? ` "${currentFileName}"` : '';
                    if (singlePercent >= 100) {
                        if (options.onLog) options.onLog(`[Video ${videoIdx}/${totalVideos}] ✔ Downloaded 100% of${nameLabel} (${totalSize})`, 'success');
                    } else {
                        if (options.onLog) options.onLog(`[Video ${videoIdx}/${totalVideos}] Downloaded ${singlePercent}% of${nameLabel} (${totalSize}) at ${speed}`, 'info');
                    }
                }
                return;
            }

            // Filter out benign / cosmetic warnings from yt-dlp (e.g. version notice or Vimeo fallback XML parse)
            if (/older than \d+ days|--no-update|failed to parse xml|not well-formed/i.test(line)) {
                return;
            }

            // If it's an error line or other meaningful output
            if (/error|failed|warning/i.test(line)) {
                if (options.onLog) options.onLog(line, 'warning');
            }
        };

        let streamBuffer = '';
        const processBuffer = (chunk) => {
            streamBuffer += chunk.toString();
            const lines = streamBuffer.split(/[\r\n]+/);
            // Retain the last segment in streamBuffer as it may be an incomplete line
            streamBuffer = lines.pop() || '';
            for (const line of lines) {
                handleLine(line);
            }
        };

        proc.stdout.on('data', processBuffer);
        proc.stderr.on('data', processBuffer);

        proc.on('close', (code) => {
            if (streamBuffer.trim()) {
                handleLine(streamBuffer.trim());
            }
            if (proc.isKilledByApp) {
                if (options.onLog) options.onLog(`[Batch Downloader] Download stopped by user.`, 'warning');
                return resolve(false);
            }
            if (code === 0) {
                if (options.onProgress) options.onProgress(100);
                if (options.onStatus) options.onStatus('completed', 'Done');
                if (options.onLog) options.onLog(`[Batch Downloader] All course media downloaded successfully!`, 'success');
                resolve(true);
            } else {
                reject(new Error(`Download script exited with code ${code}`));
            }
        });

        proc.on('error', reject);
    });
}

module.exports = {
    checkTool,
    checkMediaDependencies,
    checkYtDlp,
    cleanFileName,
    isCorruptedHtmlFile,
    saveLessonHtml,
    downloadMaterial,
    downloadVideoInline,
    runBatchDownload,
    killProcessTree,
    killAllDownloadProcesses
};
