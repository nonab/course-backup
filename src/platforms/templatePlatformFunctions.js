const { extractVideoUrls, extractDownloadLinks } = require('../core/extractors');
/**
 * Template Platform Handler
 * Use this template to create a new platform extractor.
 * Modeled after Unshackle's EXAMPLE service.
 */

module.exports = {
    // Unique identifier (lowercase, e.g., 'example', 'mycustomlms')
    id: 'template',

    // Display name shown in CLI and Desktop GUI
    name: 'Template Platform LMS',

    // Target domains associated with this platform
    domains: [
        'example.com',
        'subdomain.example.com'
    ],

    // Optional regex patterns to match course URLs
    urlPatterns: [
        /https?:\/\/(?:www\.)?example\.com\/courses\/[^\/]+/i
    ],

    // HTML keywords to identify the platform if hosted on a custom domain (fallback)
    detectionKeywords: [
        'example-lms-player',
        'example-lesson-content'
    ],

    // Supported authentication methods: 'cookies' | 'credentials' | 'guest'
    authMethods: ['cookies', 'credentials'],

    /**
     * Authenticate on the platform.
     * @param {import('puppeteer').Page} page - Puppeteer page instance
     * @param {{ username?: string, password?: string }} credentials - Login credentials
     * @param {string} baseUrl - Origin URL of the platform (e.g. 'https://example.com')
     * @param {string} platformUrl - Full input URL provided by user
     */
    async login(page, { username, password }, baseUrl, platformUrl) {
        console.log(`[${this.name}] Starting login flow...`);

        const loginUrl = `${baseUrl}/login`;
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

        // Fill credentials
        await page.type('input[type="email"], input[name="email"], input[name="username"]', username);
        await page.type('input[type="password"]', password);

        // Submit form
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.keyboard.press('Enter')
        ]);

        console.log(`[${this.name}] Login completed.`);
    },

    /**
     * Retrieve the list of courses accessible by the user.
     * @param {import('puppeteer').Page} page
     * @param {string} baseUrl
     * @param {string} platformUrl
     * @returns {Promise<Array<{ name: string, url: string }>>}
     */
    async getCourses(page, baseUrl, platformUrl) {
        console.log(`[${this.name}] Fetching course catalog...`);

        await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });

        const courses = await page.evaluate(() => {
            const courseElements = document.querySelectorAll('.course-card a');
            return Array.from(courseElements).map(el => ({
                name: el.innerText.trim() || 'Untitled Course',
                url: el.href
            })).filter(c => c.url);
        });

        return courses;
    },

    /**
     * Fetch the tree / module / lesson structure of the selected course.
     * Output format must conform to:
     * {
     *   "Course Name": {
     *     "Module 1": [
     *       { title: "Lesson 1", url: "https://..." }
     *     ]
     *   }
     * }
     * @param {import('puppeteer').Page} page
     * @param {string} courseUrl
     * @returns {Promise<Object>} Course hierarchical structure
     */
    async getStructure(page, courseUrl) {
        console.log(`[${this.name}] Extracting course outline from: ${courseUrl}`);
        await page.goto(courseUrl, { waitUntil: 'domcontentloaded' });

        const courseTitle = await page.title().then(t => t.trim());
        const structure = { [courseTitle]: {} };

        // Example extraction logic:
        const modules = await page.evaluate(() => {
            const result = {};
            const moduleCards = document.querySelectorAll('.module');
            moduleCards.forEach((card, idx) => {
                const moduleTitle = card.querySelector('.module-title')?.innerText.trim() || `Module ${idx + 1}`;
                const lessons = Array.from(card.querySelectorAll('a.lesson-link')).map(a => ({
                    title: a.innerText.trim(),
                    url: a.href
                }));
                result[moduleTitle] = lessons;
            });
            return result;
        });

        structure[courseTitle] = modules;
        return structure;
    },

    /**
     * Scrape detailed data for each lesson in the structure (videos, text HTML, downloads).
     * @param {import('puppeteer').Page} page
     * @param {Object} structure - Course structure from getStructure
     * @param {string} savePath - Destination file path for auto-saving progress
     * @returns {Promise<Object>} Enriched structure
     */
    async scrapLessonData(page, structure, savePath) {
        console.log(`[${this.name}] Scraping lesson details...`);

        for (const courseName in structure) {
            for (const moduleName in structure[courseName]) {
                const lessons = structure[courseName][moduleName];
                for (const lesson of lessons) {
                    if (!lesson.url) continue;

                    console.log(`Processing lesson: ${lesson.title}`);
                    await page.goto(lesson.url, { waitUntil: 'domcontentloaded' });

                    // Extract lesson content
                    const lessonData = await page.evaluate(() => {
                        const videoUrls = [];
                        const iframe = document.querySelector('iframe');
                        if (iframe && iframe.src) videoUrls.push(iframe.src);

                        const contentEl = document.querySelector('.lesson-content');
                        const html = contentEl ? contentEl.innerHTML : '';

                        const downloads = Array.from(document.querySelectorAll('a[download], .download-link')).map(a => ({
                            href: a.href,
                            text: a.innerText.trim() || 'material'
                        }));

                        return { videoUrls, html, downloads };
                    });

                    lesson['video url(s)'] = lessonData.videoUrls;
                    lesson.html = lessonData.html;
                    lesson.downloads = lessonData.downloads;
                }
            }
        }

        return structure;
    }
};

