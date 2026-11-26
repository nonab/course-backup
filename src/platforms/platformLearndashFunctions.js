const { extractVideoUrls } = require('../core/extractors');
const { loginWordPress } = require('../core/wordpressAuth');

// Helper functions
function addZeroPrefix(num) {
  return num < 10 ? `0${num}` : num;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function ucwords(str) {
  return str
    .toLowerCase()
    .replace(/\b[a-z]/g, char => char.toUpperCase());
}

async function login(page, credentials) {
  console.log('Logging into LearnDash platform via WordPress Auth...');
  return await loginWordPress(page, credentials, {
    fallbacks: ['/szkolenia/', '/kursy/', '/courses/', '/login/']
  });
}

async function getCourses(page, baseUrl) {
  console.log('Fetching courses from LearnDash...');

  const cleanBase = (baseUrl || '').replace(/\/+$/, '');
  const courseMap = new Map();

  async function extractCoursesFromPage() {
    return await page.evaluate(() => {
      const items = [];
      const links = Array.from(document.querySelectorAll(
        'a[href*="/courses/"], a[href*="/szkolenia/"], a[href*="/kursy/"], a[href*="/course/"]'
      ));

      for (const a of links) {
        // Exclude menu / header / footer links
        if (a.closest('header, nav, #site-navigation, .main-navigation, .ast-main-header-wrap, .menu-item, footer')) {
          continue;
        }

        const href = (a.href || '').split('?')[0].split('#')[0].replace(/\/+$/, '') + '/';
        if (
          !href ||
          href.endsWith('/courses/') ||
          href.endsWith('/szkolenia/') ||
          href.endsWith('/kursy/') ||
          href.endsWith('/course/') ||
          href.includes('/page/') ||
          href.includes('/koszyk/') ||
          href.includes('/zamowienie/') ||
          href.includes('/profil/') ||
          href.includes('/logowanie/')
        ) {
          continue;
        }

        const isCourseSlug = /\/(courses|szkolenia|kursy|course)\/[^\/]+/.test(href);
        if (!isCourseSlug) continue;

        let title = '';
        const heading = a.querySelector('h1, h2, h3, h4, .ld-course-title, .entry-title') ||
                        a.closest('.ld_course_grid_item, .ld-course-list-item, article, .course, .type-sfwd-courses, .elementor-widget')?.querySelector('h1, h2, h3, h4, .ld-course-title, .entry-title');
        
        if (heading && heading.textContent.trim()) {
          title = heading.textContent.trim();
        } else if (a.textContent.trim() && a.textContent.trim().length > 2) {
          title = a.textContent.trim();
        }

        // Clean generic CTA button titles like ">>>LINK tutaj<<<", "Przejdź", "Zobacz"
        if (title && (/^(>>>|>|przejdź|zobacz|kup|link|zapisz)/i.test(title) || title.length < 4)) {
          const prevHeading = a.parentElement?.querySelector('h1, h2, h3, h4') || a.closest('div, section')?.querySelector('h1, h2, h3, h4');
          if (prevHeading && prevHeading.textContent.trim()) {
            title = prevHeading.textContent.trim();
          } else {
            title = '';
          }
        }

        items.push({ url: href, title });
      }
      return items;
    });
  }

  // Candidate URLs to probe:
  // 1. Current page (where login redirected or where user landed)
  // 2. Base URL
  // 3. Common LMS slugs: /szkolenia/, /kursy/, /courses/, /moje-kursy/, /moje-szkolenia/, /my-courses/
  const currentUrl = page.url();
  const candidateUrls = [
    currentUrl,
    cleanBase + '/',
    cleanBase + '/szkolenia/',
    cleanBase + '/kursy/',
    cleanBase + '/courses/',
    cleanBase + '/moje-kursy/',
    cleanBase + '/moje-szkolenia/',
    cleanBase + '/my-courses/'
  ];

  const checkedUrls = new Set();

  for (const candidateUrl of candidateUrls) {
    if (checkedUrls.has(candidateUrl)) continue;
    checkedUrls.add(candidateUrl);

    try {
      if (page.url() !== candidateUrl) {
        await page.goto(candidateUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      }

      let nextPageUrl = candidateUrl;
      do {
        const found = await extractCoursesFromPage();
        for (const item of found) {
          const existing = courseMap.get(item.url) || '';
          if (!courseMap.has(item.url) || (!existing && item.title) || (item.title && item.title.length > existing.length)) {
            courseMap.set(item.url, item.title);
          }
        }

        if (found.length > 0) {
          nextPageUrl = await page.evaluate(() => {
            const next = document.querySelector('a.next.page-numbers, .ld-pagination a.next:not(.disabled)');
            return next ? next.href : null;
          });
          if (nextPageUrl && !checkedUrls.has(nextPageUrl)) {
            checkedUrls.add(nextPageUrl);
            await page.goto(nextPageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          } else {
            nextPageUrl = null;
          }
        } else {
          nextPageUrl = null;
        }
      } while (nextPageUrl);

      // If courses were found, stop probing further candidate endpoints
      if (courseMap.size > 0) {
        break;
      }
    } catch (e) {
      // Continue to next candidate URL
    }
  }

  const courses = Array.from(courseMap.entries()).map(([url, title]) => {
    let name = title;
    if (!name) {
      try {
        const parts = new URL(url).pathname.split('/').filter(Boolean);
        const last = parts[parts.length - 1] || 'course';
        name = last.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      } catch (e) {
        name = 'Course';
      }
    }
    return { name, url };
  });

  return courses;
}

async function getStructure(page, courseUrl) {
  console.log(`Fetching structure for course: ${courseUrl}`);

  await page.goto(courseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  const rawTitle = await page.title().then(t => t.trim());
  const courseTitle = rawTitle.split('–')[0].split('-')[0].trim() || 'Course';
  const structure = { [courseTitle]: {} };

  // Helper to extract lesson/module links from the current course page
  const extractItemsFromCoursePage = async () => {
    return await page.evaluate((cUrl) => {
      const items = [];
      const cleanCourseUrl = cUrl.split('?')[0].split('#')[0].replace(/\/+$/, '');
      const selectors = [
        '#learndash_course_content a',
        '#learndash_lessons a',
        '.learndash_navigation_lesson_topics_list a',
        '.ld-course-navigation a',
        '.ld-item-list a',
        '.ld-lesson-item a',
        '.ld-table-list a',
        'a.notcompleted',
        'a.completed',
        'a[href*="/lessons/"]',
        'a[href*="/modul/"]',
        'a[href*="/lekcje/"]',
        'a[href*="/lekcja/"]'
      ];

      const elements = Array.from(document.querySelectorAll(selectors.join(',')));
      for (const el of elements) {
        // Skip header / footer / menu items
        if (el.closest('header, nav, #site-navigation, .main-navigation, .ast-main-header-wrap, .menu-item, footer')) {
          continue;
        }

        const href = (el.href || '').split('#')[0];
        const cleanHref = href.split('?')[0].replace(/\/+$/, '');
        if (!href || cleanHref === cleanCourseUrl) continue;
        if (href.includes('/wp-login') || href.includes('action=') || href.includes('/profil') || href.includes('/forum/')) continue;

        let title = '';
        const titleDiv = el.querySelector('.ld-lesson-title, .ld-item-title, .entry-title') || el;
        title = (titleDiv.innerText || titleDiv.textContent || '').trim();
        if (!title || /^(«|»|›|‹|next|prev|poprzedn|następn)/i.test(title)) continue;

        items.push({ url: href, title });
      }
      return items;
    }, courseUrl);
  };

  let rawItems = await extractItemsFromCoursePage();

  // Check pagination on the course page (e.g. ?ld-lesson-page=2 or .ld-pagination)
  const paginationLinks = await page.evaluate(() => {
    const pLinks = Array.from(document.querySelectorAll('a[href*="ld-lesson-page="], .ld-pagination a, a.page-numbers')).map(a => a.href);
    return Array.from(new Set(pLinks));
  });

  const visitedPages = new Set([courseUrl.split('#')[0]]);
  for (const pUrl of paginationLinks) {
    const cleanP = pUrl.split('#')[0];
    if (cleanP && !visitedPages.has(cleanP)) {
      visitedPages.add(cleanP);
      try {
        await page.goto(cleanP, { waitUntil: 'networkidle2', timeout: 20000 });
        const moreItems = await extractItemsFromCoursePage();
        rawItems.push(...moreItems);
      } catch (err) { }
    }
  }

  // Deduplicate
  const seenModuleUrls = new Set();
  const moduleLinks = [];
  for (const item of rawItems) {
    if (!seenModuleUrls.has(item.url)) {
      seenModuleUrls.add(item.url);
      moduleLinks.push(item);
    }
  }

  let moduleCounter = 0;
  let lessonCounter = 0;

  for (const moduleItem of moduleLinks) {
    const moduleLink = moduleItem.url;
    console.log(`Processing module / lesson: ${moduleLink}`);
    moduleCounter++;
    const moduleTitle = moduleItem.title || `Module ${addZeroPrefix(moduleCounter)}`;

    structure[courseTitle][moduleTitle] = [];

    try {
      await page.goto(moduleLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.log(`Notice navigating to module: ${e.message}`);
    }

    // Check if this module/lesson page has child topics
    const processTopicLinks = async () => {
      let topicLinks = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll(
          '#primary a, .ld-topic-list a, .ld-table-list-item a, a[href*="/topic/"], a[href*="/temat/"]'
        ));
        return els
          .map(el => ({
            title: (el.innerText || el.textContent || '').trim(),
            url: (el.href || '').split('#')[0]
          }))
          .filter(link => {
            if (!link.url || link.url.includes('/wp-login') || link.url.includes('action=')) return false;
            const isTopic = link.url.includes('/topic/') || link.url.includes('/temat/');
            return isTopic && !/^(«|»|›|‹|next|prev|poprzedn|następn|previous temat|next temat)/i.test(link.title);
          });
      });

      const uniqueTopics = [];
      const seenTopics = new Set();
      for (const t of topicLinks) {
        if (!seenTopics.has(t.url)) {
          seenTopics.add(t.url);
          uniqueTopics.push(t);
        }
      }

      // If no child topics found, this module IS the lesson itself!
      if (!uniqueTopics.length) {
        structure[courseTitle][moduleTitle].push({
          title: moduleTitle,
          url: moduleLink,
          referer: courseUrl,
          "video url(s)": [],
          html: null
        });
      } else {
        for (const topic of uniqueTopics) {
          const isDuplicate = structure[courseTitle][moduleTitle].some(existing => existing.url === topic.url);
          if (isDuplicate) continue;

          lessonCounter++;
          const lessonTitle = `${addZeroPrefix(lessonCounter)} - ${moduleTitle} - ${topic.title || 'Topic'}`;
          structure[courseTitle][moduleTitle].push({
            title: lessonTitle,
            url: topic.url,
            referer: courseUrl,
            "video url(s)": [],
            html: null
          });
        }
      }
    };

    await processTopicLinks();

    // Check topic pagination inside module
    const visitedTopicPages = new Set([moduleLink]);
    let nextTopicLink;
    do {
      nextTopicLink = await page.$("div.ld-pagination.ld-pagination-page-course_topics a.next:not(.disabled), a.next.page-numbers");
      if (nextTopicLink) {
        const nextHref = await page.evaluate(link => link.href, nextTopicLink);
        if (nextHref && !visitedTopicPages.has(nextHref)) {
          visitedTopicPages.add(nextHref);
          try {
            await page.goto(nextHref, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await processTopicLinks();
          } catch (e) {
            break;
          }
        } else {
          break;
        }
      }
    } while (nextTopicLink);
  }

  return structure;
}

async function scrapLessonData(page, structure) {
  for (const courseTitle in structure) {
    const modules = structure[courseTitle];

    for (const moduleName in modules) {
      const lessons = modules[moduleName];

      for (const lesson of lessons) {
        console.log(`Processing lesson: ${lesson.title}`);
        try {
          await page.goto(lesson.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (e) {
          console.log(`Navigation notice: ${e.message}`);
        }

        // Extract video URLs from iframe elements
        lesson["video url(s)"] = await extractVideoUrls(page);

        const contentHtml = await page.evaluate(() => {
          const contentDiv = document.querySelector('.site-main, .entry-content, #content, .learndash-content, article');
          
          if (!contentDiv) {
            return null;
          }

          // Clone to avoid mutating live page
          const clone = contentDiv.cloneNode(true);

          // Remove iframes and video players (extracted separately)
          const iframes = clone.querySelectorAll('iframe, video, object, embed');
          iframes.forEach(el => el.remove());
          
          // Remove specific navigation, comment and action divs
          const removeSelectors = [
            '.ld-content-actions',
            '.ld-course-navigation',
            '.learndash_navigation_lesson_topics_list',
            '#comments',
            '.comments-area',
            '.ast-comment-form-wrap',
            '.nav-links'
          ];
          removeSelectors.forEach(sel => {
            clone.querySelectorAll(sel).forEach(el => el.remove());
          });

          // Check content length
          const contentText = clone.innerText.trim();
          if (contentText.length <= 50) {
            return null;
          }
          
          return clone.outerHTML;
        });
        lesson.html = contentHtml;
      }
    }
  }

  return structure;
}

module.exports = {
  id: 'learndash',
  isWordPress: true,
  name: 'LearnDash LMS',
  domains: [],
  detectionKeywords: ["learndash","ld-lesson-title","sfwd-courses"],
  authMethods: ["cookies","credentials"],
  login,
  getCourses,
  getStructure,
  scrapLessonData
};
