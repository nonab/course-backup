const { extractVideoUrls } = require('../core/extractors');
const { loginWordPress } = require('../core/wordpressAuth');
// platformLearndashFunctions.js
const fs = require('fs');
const path = require('path');

async function login(page, credentials) {
  console.log('Logging into Tutor LMS platform via WordPress Auth...');
  return await loginWordPress(page, credentials, {
    fallbacks: ['/dashboard/', '/courses/']
  });
}

async function extractCourses(page) {
    try {
        // Wait for either the standard course card or the dashboard course card
        await page.waitForSelector('.tutor-course-card, .tutor-mycourse-wrap, .tutor-dashboard-content-inner', {
            timeout: 5000
        }).catch(() => {});

        const courses = await page.evaluate(() => {
            const standardCards = Array.from(document.querySelectorAll('.tutor-course-card'));
            const dashboardCards = Array.from(document.querySelectorAll('.tutor-mycourse-wrap'));
            
            const results = [];

            standardCards.forEach(card => {
                const link = card.querySelector('.tutor-course-name a');
                if (link) {
                    results.push({
                        name: link.textContent.trim(),
                        url: link.href.trim()
                    });
                }
            });

            dashboardCards.forEach(card => {
                const titleEl = card.querySelector('.course-title, .tutor-course-name');
                const url = card.href;
                if (titleEl && url) {
                    results.push({
                        name: titleEl.textContent.trim(),
                        url: url.trim()
                    });
                }
            });

            return results;
        });

        return courses.filter(c => c.name && c.url);
    } catch (err) {
        return [];
    }
}

async function getCourses(page, baseUrl, platformUrl) {
    try {
        console.log("Checking current page for courses...");
        let courses = await extractCourses(page);
        if (courses.length > 0) return courses;

        console.log("No courses found, trying /dashboard/...");
        await page.goto(`${baseUrl}/dashboard/`, { waitUntil: "domcontentloaded" });
        courses = await extractCourses(page);
        if (courses.length > 0) return courses;

        console.log("No courses found, trying active-courses dashboard...");
        await page.goto(`${baseUrl}/dashboard/enrolled-courses/active-courses/`, { waitUntil: "domcontentloaded" });
        courses = await extractCourses(page);
        if (courses.length > 0) return courses;

        if (platformUrl && page.url() !== platformUrl) {
            console.log("Redirecting back to provided URL as fallback...");
            await page.goto(platformUrl, { waitUntil: "domcontentloaded" });
            courses = await extractCourses(page);
        }

        return courses;

    } catch (err) {
        console.error("TutorLMS getCourses error:", err.message);
        return [];
    }
}

async function getStructure(page, courseUrl) {
    console.log(`Getting structure from: ${courseUrl}`);

    await page.goto(courseUrl, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('.tutor-accordion-item', {
        timeout: 10000
    });

    const courseTitle = await page.evaluate(() => {
        const sel1 = document.querySelector('.tutor-course-details-title span');
        const sel2 = document.querySelector('.tutor-course-header-h1');
        const sel3 = document.querySelector('.entry-title');
        return (sel1 || sel2 || sel3)?.textContent.trim() || 'Untitled Course';
    });

    const structure = {};
    structure[courseTitle] = {};

    const modules = await page.$$eval(
        '.tutor-accordion-item',
        items => {
            return items.map(item => {
                const moduleTitleEl = item.querySelector(
                    '.tutor-accordion-item-header'
                );

                const lessons = [
                    ...item.querySelectorAll(
                        '.tutor-course-content-list-item a'
                    )
                ].map(link => ({
                    title: link.textContent.trim(),
                    url: link.href.trim()
                }));

                return {
                    moduleTitle: moduleTitleEl
                        ? moduleTitleEl.textContent.trim()
                        : 'Untitled module',
                    lessons
                };
            });
        }
    );

    for (const mod of modules) {
        if (!mod.lessons.length) continue;

        structure[courseTitle][mod.moduleTitle] = mod.lessons.map(lesson => ({
            title: lesson.title,
            url: lesson.url,
            referer: null,
            "video url(s)": [],
            html: null,
            downloads: []
        }));
    }

    console.log(`Found ${modules.length} modules`);

    return structure;
}

// Helper functions

async function scrapLessonData(page, structure, savePath) {
    console.log('Scraping lesson data...');

    for (const courseTitle of Object.keys(structure)) {
        for (const moduleTitle of Object.keys(structure[courseTitle])) {
            const lessons = structure[courseTitle][moduleTitle];

            for (const lesson of lessons) {
                console.log(`Processing: ${lesson.url}`);

                await page.goto(lesson.url, {
                    waitUntil: 'domcontentloaded'
                });

                // wait for lesson content (important for Tutor)
                await page.waitForSelector(
                    '.tutor-lesson-wrapper, .tutor-video-player-wrapper',
                    { timeout: 10000 }
                ).catch(() => {});

                const videoUrls = await page.$$eval(
                    '.tutor-video-player-wrapper iframe, .tutor-lesson-video-player iframe, iframe[src*="vimeo"], iframe[src*="youtube"]',
                    iframes => iframes.map(i => i.src).filter(Boolean)
                );

                lesson["video url(s)"] = videoUrls;

                lesson.referer = videoUrls.length
                    ? new URL(videoUrls[0]).origin
                    : null;

                lesson["video url(s)"] = await extractVideoUrls(page);

                const downloads = await page.$eval(
                    'a[href]',
                    links => links
                        .map(link => ({
                            text: link.textContent.trim(),
                            href: link.href
                        }))
                        .filter(l =>
                            l.href.includes('bpmj_eddpc_url') ||
                            /\.(zip|pdf|docx?|mp3)$/i.test(l.href)
                        )
                );

                lesson.downloads = downloads;

                // 5️⃣ HTML (ONLY <p> inside tutor wrapper)
                try {
                    const paragraphs = await page.$$eval(
                        '.tutor-lesson-wrapper p',
                        nodes => nodes.map(p => p.outerHTML)
                    );

                    lesson.html = paragraphs.join('\n');
                } catch {
                    lesson.html = null;
                }

                console.log(`✓ Done: ${lesson.title}`);
            }
        }
    }

    return structure;
}

module.exports = {
  id: 'tutor',
  isWordPress: true,
  name: 'Tutor LMS',
  domains: [],
  detectionKeywords: ["tutorlms","tutor-lms","tutor-course"],
  authMethods: ["cookies","credentials"],
  login,
  getCourses,
  getStructure,
  scrapLessonData
};
