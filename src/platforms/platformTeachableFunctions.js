const { extractVideoUrls } = require('../core/extractors');
const fs = require('fs');
const path = require("path");

async function login(page, { username, password }) {
    console.log('Logging into teachable platform...');
    const baseUrl = new URL(page.url()).origin;
    const loginUrl = baseUrl + '/sign_in';
    await page.goto(loginUrl, { waitUntil: 'networkidle2' });
    const currentUrl = page.url();
    const realLoginUrl = currentUrl.replace('otp', 'password?force=true');

    if (realLoginUrl !== currentUrl) {
        await page.goto(realLoginUrl, { waitUntil: 'networkidle2' });
    }
    await page.type('input:not([type="hidden"])', username);
    await page.type('input[type="password"]', password);
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => { });
}

async function getCourses(page, baseUrl) {
    console.log("Retrieving courses list...");
    const courses = await page.evaluate(() => {
        // Select the first iframe element
        const courseItems = document.querySelectorAll(
            'a[data-sentry-component="MyLibraryProductTile"]'
        );
        const purchasedCourses = [];

        courseItems.forEach(item => {
            // Find the course title and URL
            const titleElement = item.querySelector('p.MyLibraryProductTileName');
            if (titleElement) {
                purchasedCourses.push({
                    name: titleElement.textContent.trim(),
                    url: item.href
                });
            }
        });
        return purchasedCourses;

    });

    // Sort courses by name
    courses.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    return courses;
}

async function getStructure(page, courseUrl) {
    await page.goto(courseUrl, { waitUntil: 'networkidle2' });

    const structuredData = await page.evaluate(() => {
        const structure = {};

        // ===== COURSE TITLE =====
        const courseTitleEl = document.querySelector('.course-sidebar h2');
        if (!courseTitleEl) {
            throw new Error('Course title not found');
        }
        const courseTitle = courseTitleEl.textContent.trim();
        structure[courseTitle] = {};

        // Count total lessons to determine zero-padding length
        const allLessonItems = document.querySelectorAll('.section-list li.section-item');
        const padLength = Math.max(2, allLessonItems.length.toString().length);
        let lessonCounter = 0;

        // ===== MODULES =====
        const modules = document.querySelectorAll('.course-section');

        modules.forEach(moduleEl => {
            // Module title
            const moduleTitleEl = moduleEl.querySelector('.section-title');
            if (!moduleTitleEl) return;

            const moduleTitle = moduleTitleEl.textContent
                .replace(/\s+/g, ' ')
                .trim();

            structure[courseTitle][moduleTitle] = [];

            // ===== LESSONS =====
            const lessonItems = moduleEl.querySelectorAll('.section-list li.section-item');

            lessonItems.forEach(lessonEl => {
                const linkEl = lessonEl.querySelector('a.item');
                const titleEl = lessonEl.querySelector('.lecture-name');

                if (!linkEl || !titleEl) return;

                // Clean lesson title:
                // - remove (8:03)
                // - remove extra whitespace
                let lessonTitle = titleEl.textContent
                    .replace(/\([^)]*\)/g, '')   // remove (8:03)
                    .replace(/\s+/g, ' ')        // normalize spaces
                    .trim();

                const lessonUrl = linkEl.href;

                lessonCounter++;
                const prefix = `${String(lessonCounter).padStart(padLength, '0')} - `;

                structure[courseTitle][moduleTitle].push({
                    title: `${prefix}${lessonTitle}`,
                    url: lessonUrl
                });
            });
        });

        return structure;
    });
    return structuredData;
}

async function scrapLessonData(page, structure, savePath) {
    console.log('Scraping lesson data');
    const baseUrl = new URL(page.url()).origin;

    for (const courseTitle in structure) {
        const modules = structure[courseTitle];

        for (const moduleName in modules) {
            const lessons = modules[moduleName];

            for (const lesson of lessons) {
                console.log(`Processing lesson: ${lesson.title}`);
                await page.goto(lesson.url, { waitUntil: 'domcontentloaded' });
                await new Promise(resolve => setTimeout(resolve, 5000));

                // Extract video URLs from iframe elements
                lesson["video url(s)"] = await extractVideoUrls(page);

                const quiz = await page.evaluate(() => {
                    const quizEl = document.querySelector(
                        '.lecture-attachment.lecture-attachment-type-quiz .attachment-data'
                    );

                    if (!quizEl) return null;

                    try {
                        const schemaRaw = quizEl.getAttribute('data-schema');
                        const dataRaw = quizEl.getAttribute('data-data');

                        if (!schemaRaw || !dataRaw) return null;

                        const schema = JSON.parse(schemaRaw);
                        const data = JSON.parse(dataRaw);

                        const answerKey = data.answerKey || {};
                        const properties = schema.properties || {};

                        const questions = [];

                        Object.keys(properties).forEach((key) => {
                            const questionData = properties[key];

                            const questionText = questionData.title;
                            const possibleAnswers = questionData.enum || [];
                            const correctAnswers = answerKey[key] || [];

                            const answers = possibleAnswers.map(answerText => ({
                                text: answerText,
                                correct: correctAnswers.includes(answerText)
                            }));

                            questions.push({
                                text: questionText,
                                answers
                            });
                        });

                        return { questions };

                    } catch (e) {
                        return null;
                    }
                });
                if (quiz && quiz.questions.length > 0) {
                    lesson.quiz = quiz;
                }
                // Extract lesson content HTML
                const contentHtml = await page.evaluate(() => {
                    const textContainers = document.querySelectorAll(
                        '.lecture-attachment.lecture-attachment-type-text .lecture-text-container'
                    );
                    if (!textContainers.length) {
                        return null;
                    }
                    const parts = Array.from(textContainers)
                        .map(el => el.innerHTML.trim())
                        .filter(Boolean);
                    return parts.length ? parts.join('\n') : null;
                });
                if (contentHtml) {
                    lesson.html = contentHtml;
                }

                const downloads = await page.$$eval('a.download', links =>
                    links.map(link => ({
                        href: link.href, // Will be absolute if the browser renders it as such
                        text: link.textContent.trim()
                    }))
                );

                const pdfAttachments = await page.evaluate(() => {
                    const results = [];

                    document
                        .querySelectorAll('.lecture-attachment.lecture-attachment-type-pdf_embed')
                        .forEach(el => {
                            const labelEl = el.querySelector('.label');
                            const iframe = el.querySelector('iframe');

                            if (!iframe || !iframe.src) return;

                            try {
                                const url = new URL(iframe.src);
                                const fileParam = url.searchParams.get('file');
                                if (!fileParam) return;

                                const pdfUrl = decodeURIComponent(fileParam);

                                const name = labelEl
                                    ? labelEl.textContent.replace(/\s+/g, ' ').trim()
                                    : 'attachment.pdf';

                                results.push({
                                    href: pdfUrl,
                                    text: name
                                });
                            } catch (e) {
                                // ignore malformed URLs
                            }
                        });

                    return results;
                });

                for (const pdf of pdfAttachments) {
                    downloads.push({
                        href: pdf.href,
                        text: pdf.text
                    });
                }


                lesson["downloads"] = downloads.map(download => ({
                    href: download.href.startsWith('http') ? download.href : `${baseUrl}${download.href}`,
                    text: download.text
                }));
            }
            try {
                const basePath = path.dirname(savePath);

                if (!fs.existsSync(basePath)) {
                    fs.mkdirSync(basePath, { recursive: true });
                }

                fs.writeFileSync(savePath, JSON.stringify(structure, null, 2), 'utf8');
                console.log(`Module "${moduleName}" saved to ${savePath}`);
            } catch (error) {
                console.error(`Error saving module "${moduleName}":`, error);
            }
        }
    }


    return structure;
}

module.exports = {
    id: 'teachable',
    name: 'Teachable',
    domains: ["teachable.com", "teachablecdn.com"],
    detectionKeywords: ["teachable"],
    authMethods: ["cookies", "credentials"],
    login,
    getCourses,
    getStructure,
    scrapLessonData
};
