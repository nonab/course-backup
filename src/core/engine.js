const { EventEmitter } = require('events');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const readline = require('readline');
const { spawn } = require('child_process');
const platforms = require('../platforms');
const jsonToBat = require('./jsonToBat');
const { inspectVideoUrl } = require('./extractors');
const { saveLessonHtml, downloadMaterial, downloadVideoInline } = require('./downloader');
const { loginWordPress } = require('./wordpressAuth');
const { findCookieFile } = require('./cookieManager');
const { findBrowserExecutable, getBrowserCandidates } = require('./browserFinder');

// Global console interception management (ensures console.log is never wrapped multiple times across Electron runs)
let activeEngineLogger = null;
let isInterceptionActive = false;
const rootConsoleLog = console.log.bind(console);
const rootConsoleError = console.error.bind(console);

console.log = (...args) => {
    rootConsoleLog(...args);
    if (activeEngineLogger && !isInterceptionActive) {
        isInterceptionActive = true;
        try {
            const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            activeEngineLogger.log(msg, 'info');

            if (typeof activeEngineLogger.onLessonHook === 'function') {
                const trimmed = msg.trim();
                const match = trimmed.match(/^(?:(?:\[DEBUG\]\s*)?Processing\s+lesson(?::|\s)\s*|Processing:\s*)(.+)/i);
                if (match) {
                    activeEngineLogger.onLessonHook(match[1]);
                }
            }
        } finally {
            isInterceptionActive = false;
        }
    }
};

console.error = (...args) => {
    rootConsoleError(...args);
    if (activeEngineLogger) {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        activeEngineLogger.log(msg, 'error');
    }
};

function sanitizeFilename(filename) {
    if (!filename || typeof filename !== 'string') return '';
    return filename
        .replace(/[<>:"/\\|?*\x00-\x1F\x7F]/g, '_')
        .replace(/[^\w\s\p{L}\p{N}._-]/gu, '_')
        .replace(/\s+/g, ' ')
        .trim();
}

function getCourseInfo(course, baseUrl) {
    let courseUrl = '';
    let courseName = '';

    if (typeof course === 'string') {
        courseUrl = course.trim();
    } else if (typeof course === 'object' && course && course.url) {
        courseUrl = course.url.trim();
        courseName = (course.name || '').trim();
    }

    let slugFromUrl = '';
    if (courseUrl) {
        try {
            const parsed = new URL(courseUrl);
            const segments = parsed.pathname.split('/').filter(Boolean);
            const meaningful = segments.filter(s => !['courses', 'course', 'products', 'program', 'programs', 'watch'].includes(s.toLowerCase()));
            slugFromUrl = meaningful.pop() || segments.pop() || 'course';
        } catch (e) {
            slugFromUrl = 'course';
        }
    }

    if (!courseName || /^course\s*\d*$/i.test(courseName)) {
        courseName = slugFromUrl.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    let courseSlug = sanitizeFilename(courseName);
    if (!courseSlug || ['courses', 'course', 'products'].includes(courseSlug.toLowerCase())) {
        courseSlug = sanitizeFilename(slugFromUrl);
    }
    if (!courseSlug || ['courses', 'course', 'products'].includes(courseSlug.toLowerCase())) {
        courseSlug = 'course';
    }

    return { courseUrl, courseName, courseSlug };
}

class CourseBackupEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        this.url = options.url ? options.url.trim() : '';
        this.username = options.username ? options.username.trim() : '';
        this.password = options.password ? options.password.trim() : '';
        this.cookiesPath = options.cookiesPath || null;
        this.outputDir = options.outputDir || path.resolve(process.cwd(), 'output');
        this.mode = options.mode || 'json';
        this.headless = options.headless !== undefined ? !!options.headless : true;
        this.isAudioOnly = !!options.isAudioOnly;
        this.crss = options.crss || null;
        this.includeExtensions = options.includeExtensions || [];
        this.excludeExtensions = options.excludeExtensions || [];

        this.browser = null;
        this.page = null;
        this.isCancelled = false;
        this.activeProcess = null;
        this.selectionResolver = null;
        this.onLessonHook = null;
        this.tempProfileDir = null;
    }

    cleanUpTempProfile() {
        if (this.tempProfileDir) {
            try {
                if (fs.existsSync(this.tempProfileDir)) {
                    fs.rmSync(this.tempProfileDir, { recursive: true, force: true });
                }
            } catch (_) { }
            this.tempProfileDir = null;
        }
    }

    log(message, type = 'info') {
        this.emit('log', { message, type });
        try {
            const logFile = path.resolve(this.outputDir, 'course-backup.log');
            const dir = path.dirname(logFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
            fs.appendFileSync(logFile, `[${timestamp}] [${type.toUpperCase()}] ${message}\n`);
        } catch (e) { }
    }

    updateStatus(state, text = '') {
        this.emit('status', { state, text });
    }

    updateProgress(percent) {
        const clamped = Math.max(0, Math.min(100, Math.round(percent)));
        this.emit('progress', clamped);
    }

    async loadCookies(page, cookiesPath) {
        if (!fs.existsSync(cookiesPath)) return;
        try {
            const raw = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
            const cleaned = raw.map(c => {
                const copy = { ...c };
                delete copy.id;
                delete copy.hostOnly;
                delete copy.session;
                delete copy.storeId;
                if (copy.expirationDate) {
                    copy.expires = copy.expirationDate;
                    delete copy.expirationDate;
                }
                if (copy.sameSite === 'unspecified' || !['Strict', 'Lax', 'None'].includes(copy.sameSite)) {
                    delete copy.sameSite;
                }
                return copy;
            });
            await page.setCookie(...cleaned);
            this.log('Cookies loaded successfully.', 'success');
        } catch (e) {
            this.log(`Failed to load cookies from ${cookiesPath}: ${e.message}`, 'error');
        }
    }

    saveJson(data, courseSlug, platformDir) {
        const outputDir = path.join(platformDir, courseSlug);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        const filePath = path.join(outputDir, `${courseSlug}.json`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        this.log(`Structure saved: ${filePath}`, 'success');
        return filePath;
    }

    async detectPlatform(page, url) {
        this.log('Detecting platform...', 'info');
        let platform = platforms.match(url);
        if (platform) {
            this.log(`Platform detected: ${platform.name} (${platform.id})`, 'info');
            return platform;
        }

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (e) {
            this.log(`Navigation notice: ${e.message}`, 'warning');
        }

        const pageContent = await page.content().catch(() => '');
        platform = platforms.match(url, pageContent);

        if (platform) {
            this.log(`Platform detected from page content: ${platform.name} (${platform.id})`, 'info');
            return platform;
        }

        const err = new Error('No matching platform adapter found.');
        err.isUnknownPlatform = true;
        this.log('💡 Platform not supported yet. You can request a custom adapter on Ko-fi: https://ko-fi.com/nonab/commissions?commissionAlias=df83097268#buyShopCommissionModal', 'warning');
        throw err;
    }

    selectCourses(selection) {
        if (this.selectionResolver) {
            this.selectionResolver(selection);
            this.selectionResolver = null;
        }
    }

    async cancel() {
        this.isCancelled = true;
        this.updateStatus('cancelled', 'Cancelling process...');
        this.log('Cancellation requested by user.', 'warning');

        if (this.activeProcess) {
            try {
                const { killProcessTree } = require('./downloader');
                killProcessTree(this.activeProcess);
            } catch (e) {
                try { this.activeProcess.kill('SIGTERM'); } catch (err) { }
            }
            this.activeProcess = null;
        }

        try {
            const { killAllDownloadProcesses } = require('./downloader');
            killAllDownloadProcesses();
        } catch (e) { }

        if (this.browser) {
            try {
                const bProc = this.browser.process();
                if (bProc && bProc.pid) {
                    const { killProcessTree } = require('./downloader');
                    killProcessTree(bProc);
                }
                await Promise.race([
                    this.browser.close(),
                    new Promise(resolve => setTimeout(resolve, 500))
                ]);
            } catch (e) { }
            this.browser = null;
        }

        this.cleanUpTempProfile();
        this.updateStatus('idle', 'Process cancelled.');
        this.emit('cancelled');
    }

    async start() {
        if (!this.url) {
            throw new Error('URL is required to start course migration.');
        }

        if ((this.username && !this.password) || (!this.username && this.password)) {
            throw new Error('Both username and password must be provided for authentication, or leave both empty to rely on session cookies.');
        }

        this.isCancelled = false;
        this.updateStatus('scraping', 'Initializing browser...');
        this.log(`Starting migration session for: ${this.url}`, 'info');

        activeEngineLogger = this;
        this.onLessonHook = null;

        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-web-security',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=msEdgeSharedContext,msEdgeSidebar,msHub,msEdgeStartupBoost',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding'
        ];

        // Isolated temporary profile directory prevents Edge/Chrome from attaching to existing running instances (Exit Code: 0)
        try {
            this.tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-profile-'));
        } catch (_) {
            this.tempProfileDir = path.join(os.tmpdir(), `cb-profile-${Date.now()}`);
        }

        const candidates = await getBrowserCandidates();
        let lastError = null;

        for (const candidate of candidates) {
            try {
                this.browser = await puppeteer.launch({
                    executablePath: candidate.path,
                    headless: this.headless,
                    userDataDir: this.tempProfileDir,
                    defaultViewport: null,
                    args: launchArgs
                });
                this.browserInfo = candidate;
                this.log(`Using browser: ${candidate.name}`, 'info');
                lastError = null;
                break;
            } catch (err) {
                this.log(`Could not launch ${candidate.name} (${err.message}). Trying fallback browser...`, 'warning');
                lastError = err;
            }
        }

        if (!this.browser) {
            throw lastError || new Error('Could not launch any Chromium-compatible browser (Edge, Chrome, Brave).');
        }

        const pages = await this.browser.pages();
        this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await this.page.setExtraHTTPHeaders({ 'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7' });

        try {
            const platformFunctions = await this.detectPlatform(this.page, this.url);
            const platformId = platformFunctions.id;

            let hostname;
            try {
                hostname = new URL(this.url).hostname.replace(/^www\./, '');
            } catch (e) {
                hostname = this.url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
            }

            const platformDir = path.resolve(this.outputDir, hostname);
            if (!fs.existsSync(platformDir)) {
                fs.mkdirSync(platformDir, { recursive: true });
            }

            // Determine cookies path if not passed explicitly (smart wildcard resolution)
            let resolvedCookiesPath = this.cookiesPath;
            if (!resolvedCookiesPath) {
                resolvedCookiesPath = findCookieFile(this.url, platformFunctions?.id);
            }

            if (resolvedCookiesPath && fs.existsSync(resolvedCookiesPath)) {
                this.updateStatus('scraping', 'Loading session cookies...');
                this.log(`Loading session cookies from: ${resolvedCookiesPath}`, 'info');
                await this.loadCookies(this.page, resolvedCookiesPath);
            }

            // Authentication
            const baseUrl = new URL(this.url).origin;
            if (this.username && this.password) {
                // Ensure page has loaded the target URL before login if it is still on about:blank
                if (this.page.url() === 'about:blank' || this.page.url().startsWith('about:')) {
                    try {
                        await this.page.goto(this.url, { waitUntil: 'domcontentloaded' });
                    } catch (e) {
                        this.log(`Navigation warning for ${this.url}: ${e.message}`, 'warning');
                    }
                }

                this.updateStatus('scraping', `Authenticating with ${platformFunctions.name}...`);
                this.log(`Logging into ${platformFunctions.name}...`, 'info');
                if (typeof platformFunctions.login === 'function') {
                    await platformFunctions.login(this.page, {
                        username: this.username,
                        password: this.password,
                        url: this.url,
                        baseUrl
                    });
                } else if (platformFunctions.isWordPress) {
                    await loginWordPress(this.page, {
                        username: this.username,
                        password: this.password,
                        url: this.url,
                        baseUrl
                    });
                }
                this.log('Authentication completed.', 'success');
            }

            if (this.page.url() !== this.url) {
                await this.page.goto(this.url, { waitUntil: 'domcontentloaded' }).catch(err => {
                    this.log(`Navigation warning for ${this.url}: ${err.message}`, 'warning');
                });
            }

            // Fetch course list
            this.updateStatus('scraping', 'Fetching course list...');
            this.log('Fetching available courses...', 'info');

            let courses = await platformFunctions.getCourses(this.page, baseUrl, this.url);

            if (!Array.isArray(courses) || courses.length === 0) {
                // Check if this.url is merely a platform root rather than a specific course URL
                let isPlatformRoot = false;
                try {
                    const parsedUrl = new URL(this.url);
                    const segments = parsedUrl.pathname.split('/').filter(Boolean);
                    const meaningfulSegments = segments.filter(s => !['library', 'login', 'sign_in', 'categories', 'courses', 'products'].includes(s.toLowerCase()));
                    if (meaningfulSegments.length === 0) {
                        isPlatformRoot = true;
                    }
                } catch (e) { }

                if (isPlatformRoot) {
                    throw new Error(`No courses found on platform library at ${this.url}. Please ensure you are logged in with valid credentials or session cookies, and that your account has enrolled courses.`);
                }

                // Single manual course fallback for direct course URLs
                const { courseUrl, courseName } = getCourseInfo(this.url, baseUrl);
                courses = [{ url: courseUrl || this.url, name: courseName }];
            }

            // Normalize courses with getCourseInfo
            const normalizedCourses = courses.map((c, index) => {
                const info = getCourseInfo(c, baseUrl);
                return {
                    id: index + 1,
                    name: info.courseName,
                    url: info.courseUrl,
                    slug: info.courseSlug
                };
            });

            this.log(`Discovered ${normalizedCourses.length} course(s).`, 'info');

            let selectedCourses = [];

            if (normalizedCourses.length === 1) {
                selectedCourses = normalizedCourses;
            } else if (this.crss && this.crss !== 'prompt') {
                if (this.crss === '0' || this.crss === 0) {
                    selectedCourses = normalizedCourses;
                } else {
                    const ids = String(this.crss).split(',').map(s => parseInt(s.trim(), 10) - 1);
                    selectedCourses = ids.filter(idx => idx >= 0 && idx < normalizedCourses.length).map(idx => normalizedCourses[idx]);
                }
            } else {
                // Emit event for UI / CLI prompt and wait for selection
                this.updateStatus('scraping', 'Waiting for course selection...');

                const userSelection = await new Promise((resolve) => {
                    this.selectionResolver = resolve;
                    this.emit('courses', normalizedCourses);
                });

                if (this.isCancelled) return;

                if (userSelection === '0' || userSelection === 0) {
                    selectedCourses = normalizedCourses;
                } else if (Array.isArray(userSelection)) {
                    selectedCourses = userSelection.map(item => {
                        if (typeof item === 'object') return item;
                        const idx = parseInt(item, 10) - 1;
                        return normalizedCourses[idx];
                    }).filter(Boolean);
                } else if (typeof userSelection === 'string') {
                    const ids = userSelection.split(',').map(s => parseInt(s.trim(), 10) - 1);
                    selectedCourses = ids.filter(idx => idx >= 0 && idx < normalizedCourses.length).map(idx => normalizedCourses[idx]);
                }
            }

            if (selectedCourses.length === 0) {
                this.log('No courses selected for processing. Finishing.', 'warning');
                this.updateStatus('idle', 'No courses selected.');
                if (this.browser) await this.browser.close();
                return;
            }

            this.log(`Selected ${selectedCourses.length} course(s) to process.`, 'info');

            const processedCourses = [];

            // Process each selected course
            for (let i = 0; i < selectedCourses.length; i++) {
                if (this.isCancelled) break;

                const courseItem = selectedCourses[i];
                const { courseUrl, courseName, courseSlug } = getCourseInfo(courseItem, baseUrl);

                this.updateStatus('scraping', `Processing course [${i + 1}/${selectedCourses.length}]: ${courseName}...`);
                this.log(`\n========================================\n[${i + 1}/${selectedCourses.length}] Processing Course: ${courseName}\n========================================`, 'info');

                const savePath = path.join(platformDir, courseSlug, `${courseSlug}.json`);
                let structure = null;

                // Check cached structure
                if (fs.existsSync(savePath)) {
                    try {
                        const cached = JSON.parse(fs.readFileSync(savePath, 'utf8'));
                        if (cached && Object.keys(cached).length > 0) {
                            this.log(`Found existing structure cache: ${savePath}`, 'info');
                            structure = cached;
                        }
                    } catch (e) { }
                }

                if (!structure) {
                    this.log(`Extracting structure from: ${courseUrl}`, 'info');
                    structure = await platformFunctions.getStructure(this.page, courseUrl);
                }

                if (!structure) {
                    this.log(`Could not obtain structure for ${courseName}. Skipping.`, 'error');
                    continue;
                }

                // Count total lessons and check for already cached content
                let totalLessons = 0;
                let alreadyScrapedLessons = 0;
                const seenInThisCourse = new Set();

                for (const topKey in structure) {
                    const modules = structure[topKey];
                    if (modules && typeof modules === 'object') {
                        for (const mod in modules) {
                            if (Array.isArray(modules[mod])) {
                                totalLessons += modules[mod].length;
                                for (const lesson of modules[mod]) {
                                    if (lesson && (
                                        (Array.isArray(lesson['video url(s)']) && lesson['video url(s)'].length > 0) ||
                                        (typeof lesson.html === 'string' && lesson.html.length > 0) ||
                                        (Array.isArray(lesson.downloads) && lesson.downloads.length > 0)
                                    )) {
                                        alreadyScrapedLessons++;
                                        if (lesson.title) seenInThisCourse.add(String(lesson.title).trim());
                                        if (lesson.url) seenInThisCourse.add(String(lesson.url).trim());
                                    }
                                }
                            }
                        }
                    }
                }

                this.log(`Total lessons in course: ${totalLessons} (${alreadyScrapedLessons} already cached)`, 'info');

                let currentLessonInCourse = alreadyScrapedLessons;
                const updateLessonProgress = (lessonInfo = '') => {
                    const rawKey = String(lessonInfo).trim();
                    if (rawKey && seenInThisCourse.has(rawKey)) {
                        return;
                    }
                    if (rawKey) {
                        seenInThisCourse.add(rawKey);
                    }

                    currentLessonInCourse++;
                    const courseFraction = totalLessons > 0 ? Math.min(1, currentLessonInCourse / totalLessons) : 0;
                    const overallPercent = Math.min(99, Math.round(((i + courseFraction) / selectedCourses.length) * 100));

                    this.updateProgress(overallPercent);
                    this.updateStatus('scraping', 'Scraping Lessons...');
                };

                // Initialize progress for this course
                const initialFraction = totalLessons > 0 ? (alreadyScrapedLessons / totalLessons) : 0;
                const initialPercent = Math.min(99, Math.round(((i + initialFraction) / selectedCourses.length) * 100));
                this.updateProgress(initialPercent);

                if (alreadyScrapedLessons > 0 && alreadyScrapedLessons === totalLessons) {
                    this.updateStatus('scraping', `All ${totalLessons} lessons already cached for ${courseName}. Verifying...`);
                } else if (alreadyScrapedLessons > 0) {
                    this.updateStatus('scraping', `Resuming ${courseName} (${alreadyScrapedLessons}/${totalLessons} cached)...`);
                } else {
                    this.updateStatus('scraping', `Scraping lessons for ${courseName} (0/${totalLessons})...`);
                }

                // Scrape lesson details with progress hook
                this.onLessonHook = updateLessonProgress;
                try {
                    structure = await platformFunctions.scrapLessonData(this.page, structure, savePath, updateLessonProgress);
                } finally {
                    this.onLessonHook = null;
                }

                // Save JSON
                const savedFile = this.saveJson(structure, courseSlug, platformDir);
                const courseDir = path.join(platformDir, courseSlug);

                // Smart Downloader: Direct Node.js extraction for HTML and Materials, and Inline Video for Expiring Tokens
                let hasExpiringVideos = false;
                let pendingDurableVideos = 0;

                if (this.mode === 'all' || this.mode === 'files' || this.mode.includes('download')) {
                    this.log(`\n[Smart Downloader] Processing lesson materials & assets for ${courseName}...`, 'info');

                    // Extract session cookies and user-agent from Puppeteer for authenticated downloads
                    let cookieHeader = '';
                    let userAgent = '';
                    if (this.page && !this.page.isClosed()) {
                        try {
                            const cookies = await this.page.cookies();
                            cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                        } catch (e) {}
                        try {
                            userAgent = await this.page.evaluate(() => navigator.userAgent);
                        } catch (e) {}
                    }

                    let savedHtmlCount = 0;
                    for (const topKey in structure) {
                        const modules = structure[topKey];
                        if (modules && typeof modules === 'object') {
                            for (const mod in modules) {
                                if (Array.isArray(modules[mod])) {
                                    for (const lesson of modules[mod]) {
                                        if (!lesson) continue;

                                        // 1. Save HTML lesson content directly via Node.js
                                        if (lesson.html && typeof lesson.html === 'string' && lesson.html.trim()) {
                                            try {
                                                saveLessonHtml(lesson.html, lesson.title, courseDir);
                                                savedHtmlCount++;
                                            } catch (e) {
                                                this.log(`Notice: Could not save HTML for ${lesson.title}: ${e.message}`, 'warning');
                                            }
                                        }

                                        // 2. Download lesson attachments / materials directly via Node.js
                                        if (Array.isArray(lesson.downloads) && lesson.downloads.length > 0) {
                                            for (const item of lesson.downloads) {
                                                const fileUrl = typeof item === 'object' ? item.href : item;
                                                const fileName = typeof item === 'object' ? (item.text || item.name) : '';
                                                if (fileUrl) {
                                                    try {
                                                        const displayName = fileName || path.basename(fileUrl);
                                                        this.log(`Downloading material: ${displayName}...`, 'info');
                                                        await downloadMaterial(fileUrl, fileName, courseDir, {
                                                            cookies: cookieHeader,
                                                            referer: lesson.url || this.page?.url?.() || '',
                                                            userAgent,
                                                            page: this.page
                                                        });
                                                        this.log(`Downloaded material: ${displayName}`, 'success');
                                                    } catch (e) {
                                                        this.log(`Notice: Could not download material "${fileName}": ${e.message}`, 'warning');
                                                    }
                                                }
                                            }
                                        }

                                        // 3. Inspect video URLs for expiring tokens vs durable streams
                                        const videoUrls = Array.isArray(lesson['video url(s)']) ? lesson['video url(s)'] : [];
                                        for (const vUrl of videoUrls) {
                                            const insp = inspectVideoUrl(vUrl);
                                            if (insp.hasExpiringToken) {
                                                hasExpiringVideos = true;
                                                if (this.mode === 'all') {
                                                    this.log(`[${insp.provider.toUpperCase()}] Detected expiring playback token for: ${lesson.title}. Downloading video inline...`, 'info');
                                                    try {
                                                        await downloadVideoInline(vUrl, lesson.title, courseDir, {
                                                            referer: lesson.referer,
                                                            onLog: (line) => this.log(line, 'info')
                                                        });
                                                    } catch (e) {
                                                        this.log(`Inline video download notice for ${lesson.title}: ${e.message}`, 'warning');
                                                    }
                                                }
                                            } else {
                                                pendingDurableVideos++;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if (savedHtmlCount > 0) {
                        this.log(`Saved ${savedHtmlCount} HTML lesson file(s) into course directory.`, 'success');
                    }
                }

                // Generate batch files for durable streams or deferred downloads
                let lastBatPath = null;
                if (this.mode === 'all' || this.mode.includes('bat') || this.mode.includes('download')) {
                    await jsonToBat.processDirectory(courseDir, null, { audioOnly: this.isAudioOnly });
                    const candidateBat = path.join(courseDir, `${courseSlug}.bat`);
                    if (fs.existsSync(candidateBat)) {
                        lastBatPath = candidateBat;
                        this.log(`Batch download script generated: ${path.basename(candidateBat)}`, 'info');
                    } else {
                        this.log(`No video downloads required for "${courseName}".`, 'info');
                    }
                }

                processedCourses.push({
                    name: courseName,
                    slug: courseSlug,
                    jsonPath: savedFile,
                    courseDir,
                    batPath: lastBatPath
                });

                this.updateProgress(Math.round(((i + 1) / selectedCourses.length) * 100));
            }

            this.updateProgress(100);
            this.updateStatus('completed', 'Migration export completed successfully!');
            this.log('\nAll selected courses processed successfully!', 'success');

            const allBatPaths = processedCourses.map(c => c.batPath).filter(Boolean);
            const primaryBat = allBatPaths[0] || null;

            this.emit('completed', {
                outputDir: platformDir,
                courses: processedCourses,
                batPath: primaryBat,
                batPaths: allBatPaths,
                hasBatch: allBatPaths.length > 0
            });

        } catch (error) {
            const isUnknownPlatform = !!error.isUnknownPlatform || (error.message && error.message.includes('No matching platform adapter'));
            if (!isUnknownPlatform) {
                this.log(`Error during migration: ${error.message}`, 'error');
            }
            this.updateStatus('error', isUnknownPlatform ? 'Platform not supported' : `Error: ${error.message}`);
            this.emit('error', error);
        } finally {
            this.onLessonHook = null;
            if (activeEngineLogger === this) {
                activeEngineLogger = null;
            }
            if (this.browser) {
                try {
                    await this.browser.close();
                } catch (e) { }
                this.browser = null;
            }
            this.cleanUpTempProfile();
        }
    }
}

module.exports = {
    CourseBackupEngine,
    sanitizeFilename,
    getCourseInfo
};
