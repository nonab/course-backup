const { extractVideoUrls } = require('../core/extractors');
const { loginWordPress } = require('../core/wordpressAuth');
// platformSenseiFunctions.js
const fs = require('fs');
const path = require('path');

async function login(page, credentials) {
  console.log('Logging into Sensei LMS platform via WordPress Auth...');
  return await loginWordPress(page, credentials, {
    fallbacks: ['/moje-szkolenia/', '/my-courses/', '/profil/']
  });
}

async function getCourses(page, baseUrl, platformUrl) {
  console.log('Fetching courses from Sensei LMS...');

  // Navigate to the provided URL if not already there
  if (page.url() !== platformUrl && page.url() !== (platformUrl + '/')) {
    await page.goto(platformUrl, { waitUntil: 'networkidle2' });
  }

  // Helper to scrape courses from current page
  const scrapeFromCurrentPage = async () => {
    return await page.evaluate(() => {
      const courseLinks = [];
      const elements = document.querySelectorAll('.course-container li.course h3 a, .course-container li.user-active h3 a, .course-excerpt h3 a');
      elements.forEach(el => {
        courseLinks.push({ name: el.innerText.trim(), url: el.href });
      });
      return courseLinks;
    });
  };

  let courses = await scrapeFromCurrentPage();

  // If no courses found, try to find the "My Courses" link in the menu or go to default paths
  if (courses.length === 0) {
    console.log('No courses found on current page, searching for "Moje szkolenia" or dashboard link...');

    const dashboardUrl = await page.evaluate(() => {
      // Look for common Polish and English Sensei dashboard links
      const dashboardLink = Array.from(document.querySelectorAll('a')).find(a =>
        /moje szkolenia|moje kursy|my courses|dashboard/i.test(a.innerText) ||
        a.href.includes('/moje-szkolenia/') ||
        a.href.includes('/my-courses/')
      );
      return dashboardLink ? dashboardLink.href : null;
    });

    if (dashboardUrl) {
      console.log(`Navigating to dashboard: ${dashboardUrl}`);
      await page.goto(dashboardUrl, { waitUntil: 'networkidle2' });
      courses = await scrapeFromCurrentPage();
    } else {
      // Fallback to common paths if link is not found
      const fallbacks = ['/moje-szkolenia/', '/my-courses/', '/dashboard/'];
      for (const path of fallbacks) {
        console.log(`Trying fallback path: ${path}`);
        await page.goto(baseUrl + path, { waitUntil: 'networkidle2' });
        courses = await scrapeFromCurrentPage();
        if (courses.length > 0) break;
      }
    }
  }

  // After finding regular courses, check for global account downloads
  const downloadsUrl = baseUrl + '/profil/downloads/';
  console.log('Checking for account-wide downloads at:', downloadsUrl);
  await page.goto(downloadsUrl, { waitUntil: 'networkidle2' });
  
  const hasDownloads = await page.evaluate(() => {
    const table = document.querySelector('.woocommerce-table--order-downloads, .shop_table.order_details');
    return table && table.querySelectorAll('tr').length > 1; // More than just header
  });

  if (hasDownloads) {
    console.log('Account downloads found, adding to course list.');
    courses.push({
      name: 'downloads',
      url: downloadsUrl
    });
  }

  console.log(`Found ${courses.length} items to process.`);
  return courses;
}

async function getStructure(page, courseUrl) {
  console.log(`Fetching structure for course: ${courseUrl}`);

  if (courseUrl.includes('/profil/downloads/')) {
    return {
      "downloads": {
        "files": [
          {
            title: "01 - downloads",
            url: courseUrl,
            referer: courseUrl,
            "video url(s)": [],
            html: null,
            downloads: []
          }
        ]
      }
    };
  }

  await page.goto(courseUrl, { waitUntil: 'networkidle2' });

  const courseTitle = await page.evaluate(() => {
    const titleEl = document.querySelector('h1') || document.querySelector('.main-title-section h1');
    return titleEl ? titleEl.innerText.trim() : document.title.replace(' | Kamil Bełz', '').trim();
  });

  const structure = { [courseTitle]: {} };

  // Scrape modules and lessons
  const data = await page.evaluate(() => {
    const results = {};
    const moduleContainers = document.querySelectorAll('section.module-container, div.module');

    if (moduleContainers.length > 0) {
      moduleContainers.forEach(moduleEl => {
        const moduleHeader = moduleEl.querySelector('header h2, h2.module-title');
        const moduleName = moduleHeader ? moduleHeader.innerText.trim() : 'General';

        const lessons = [];
        const lessonLinks = moduleEl.querySelectorAll('article.lesson h2 a, li.lesson a');
        lessonLinks.forEach(link => {
          lessons.push({
            title: link.innerText.trim(),
            url: link.href
          });
        });

        if (lessons.length > 0) {
          results[moduleName] = lessons;
        }
      });
    }

    // Check for lessons not in modules
    const standaloneLessons = [];
    const allLessonLinks = document.querySelectorAll('section.course-lessons article.lesson h2 a, ul.course-lessons li.lesson a');

    allLessonLinks.forEach(link => {
      const lessonTitle = link.innerText.trim();
      const lessonUrl = link.href;

      // Check if this lesson is already in a module
      const alreadyIncluded = Object.values(results).some(moduleLessons =>
        moduleLessons.some(l => l.url === lessonUrl)
      );

      if (!alreadyIncluded) {
        standaloneLessons.push({
          title: lessonTitle,
          url: lessonUrl
        });
      }
    });

    if (standaloneLessons.length > 0) {
      results['General'] = results['General'] ? [...results['General'], ...standaloneLessons] : standaloneLessons;
    }

    return results;
  });

  // Map to final structure format
  let lessonCounter = 0;
  for (const moduleName in data) {
    structure[courseTitle][moduleName] = data[moduleName].map(lesson => {
      lessonCounter++;
      return {
        title: `${String(lessonCounter).padStart(2, '0')} - ${lesson.title}`,
        url: lesson.url,
        referer: courseUrl,
        "video url(s)": [],
        html: null,
        downloads: []
      };
    });
  }

  return structure;
}

async function scrapLessonData(page, structure, savePath) {
  console.log('Scraping lesson data from Sensei LMS...');

  for (const courseTitle in structure) {
    for (const moduleName in structure[courseTitle]) {
      const lessons = structure[courseTitle][moduleName];

      for (const lesson of lessons) {
        console.log(`Processing lesson: ${lesson.title}`);
        
        if (lesson.url.includes('/profil/downloads/')) {
          console.log('Scraping account-wide downloads...');
          await page.goto(lesson.url, { waitUntil: 'networkidle2' });
          
          const accountDownloads = await page.evaluate(() => {
            const table = document.querySelector('.woocommerce-table--order-downloads, .shop_table.order_details');
            if (!table) return [];
            
            const rows = Array.from(table.querySelectorAll('tr')).slice(1); // Skip header
            return rows.map(row => {
              const productLink = row.querySelector('.download-product a');
              const downloadLink = row.querySelector('.download-file a');
              return {
                text: (productLink ? productLink.innerText.trim() : 'Download'),
                href: (downloadLink ? downloadLink.href : null)
              };
            }).filter(d => d.href);
          });
          
          lesson.downloads = accountDownloads.map(d => ({
            text: d.text,
            href: d.href
          }));
          lesson.html = 'Account-wide downloads generated by current user.';
          continue; // Skip standard lesson scraping
        }

        await page.goto(lesson.url, { waitUntil: 'networkidle2' });

        // Extract video URLs
        lesson["video url(s)"] = await extractVideoUrls(page);

        // Extract content HTML
        const contentData = await page.evaluate(() => {
          const contentDiv = document.querySelector('.entry-content') || document.querySelector('section.entry') || document.querySelector('.site-main');
          if (!contentDiv) return { html: null, downloads: [] };

          const clone = contentDiv.cloneNode(true);

          // Remove iframes and other noise
          const noise = clone.querySelectorAll('iframe, .sensei-message, .course-meta, .lesson-meta, script, style, .social-bookmark, .social-share');
          noise.forEach(el => el.remove());

          // Extract downloads
          const downloadLinks = [];
          const links = clone.querySelectorAll('a[href]');
          links.forEach(link => {
            const href = link.href;
            const text = link.innerText.trim() || path.basename(href);
            if (/\.(pdf|zip|rar|docx?|xlsx?|pptx?|mp3|mp4|7z)$/i.test(href)) {
              downloadLinks.push({ text: text || 'Download', href: href });
            }
          });

          return {
            html: clone.innerHTML.trim(),
            downloads: downloadLinks
          };
        });

        lesson.html = contentData.html;
        lesson.downloads = contentData.downloads;

        // Save progress incrementally if structure is large
        // fs.writeFileSync(savePath, JSON.stringify(structure, null, 2));
      }
    }
  }

  return structure;
}

module.exports = {
  id: 'sensei',
  name: 'Sensei LMS',
  isWordPress: true,
  domains: [],
  detectionKeywords: ["woothemes-sensei","sensei-lms"],
  authMethods: ["cookies","credentials"],
  login,
  getCourses,
  getStructure,
  scrapLessonData
};
