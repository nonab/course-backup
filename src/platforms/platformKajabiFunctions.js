const fs = require('fs');
const path = require('path');

async function login(page, { username, password }) {

  const checkCloudflare = async () => {
    return await page.evaluate(() => {
      const title = document.title || '';
      const text = document.body ? document.body.innerText.toLowerCase() : '';
      return title.includes('Cloudflare') || text.includes('you have been blocked') || text.includes('security service to protect itself') || !!document.querySelector('#challenge-running, .cf-turnstile');
    }).catch(() => false);
  };

  let currentUrl = page.url();
  if (!currentUrl.endsWith('/login')) {
    const targetLogin = currentUrl.replace(/\/+$/, '') + '/login';
    await page.goto(targetLogin, { waitUntil: 'networkidle2' });
  }

  if (await checkCloudflare()) {
    throw new Error('Access blocked by Cloudflare security check. Please export session cookies (.json) or enable "Show browser window" to solve the challenge.');
  }

  const emailSelector = 'input[type="email"], input[name="email"], input[type="text"]';
  try {
    await page.waitForSelector(emailSelector, { timeout: 10000 });
  } catch (e) {
    if (await checkCloudflare()) {
      throw new Error('Access blocked by Cloudflare security check. Please export session cookies (.json) or enable "Show browser window" to solve the challenge.');
    }
    throw new Error(`Login form not found on ${page.url()}. The platform may require cookies or a visible browser window.`);
  }

  const loginUrlBefore = page.url();

  await page.type(emailSelector, username);
  await page.type('input[type="password"]', password);

  const submitBtn = await page.$('button[type="submit"], input[type="submit"], form button');
  if (submitBtn) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { }),
      submitBtn.click()
    ]);
  } else {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { }),
      page.keyboard.press('Enter')
    ]);
  }

  // Allow brief time for DOM updates, redirects, or error banners
  await new Promise(r => setTimeout(r, 2000));

  currentUrl = page.url();
  const passwordInputStillExists = await page.$('input[type="password"]');
  const isStillOnLoginUrl = currentUrl === loginUrlBefore ||
    currentUrl.endsWith('/login') ||
    currentUrl.includes('/login') ||
    currentUrl.includes('/sign_in') ||
    currentUrl.includes('/users/sign_in');

  if (isStillOnLoginUrl || passwordInputStillExists) {
    const errorNotice = await page.evaluate(() => {
      const alertEl = document.querySelector('.alert, .alert-danger, .flash-message, [data-testid="error-message"], .form-error');
      if (alertEl && alertEl.textContent.trim()) return alertEl.textContent.trim();
      const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
      if (bodyText.includes("niepoprawny") || bodyText.includes("invalid") || bodyText.includes("failed")) {
        return "Invalid email or password.";
      }
      return null;
    });
    throw new Error(`Login failed: ${errorNotice || "Invalid email or password."}`);
  }

  console.log("Logged in successfully, moving to course library.");

  const cookieButtonSelector = '#cookiescript_accept';
  const cookieButtonVisible = await page.$eval(cookieButtonSelector, (el) => {
    return el && window.getComputedStyle(el).display !== 'none';
  }).catch(() => false);

  if (cookieButtonVisible) {
    console.log("Cookie popup detected, accepting cookies...");
    await page.click(cookieButtonSelector);
    await new Promise(r => setTimeout(r, 1000));
    console.log("Cookies accepted.");
  }
}

async function getCourses(page, baseUrl) {
  console.log('Fetching courses from Kajabi...');

  let nextPageUrl = baseUrl + '/library';
  const courseData = new Map();

  // Function to convert a string to Title Case
  const ucwords = (str) => {
    return str.replace(/\b\w/g, char => char.toUpperCase());
  };

  do {
    await page.goto(nextPageUrl, { waitUntil: 'networkidle2' });

    // Check if redirected to login
    const currentUrl = page.url();
    const isLoginPage = currentUrl.includes('/login') || currentUrl.includes('/sign_in') || await page.$('input[type="password"]');
    if (isLoginPage) {
      throw new Error(`Authentication required: Cannot fetch courses because access was redirected to login page (${currentUrl}). Please check your credentials or session cookies.`);
    }

    // Extract course links and names
    const linksOnPage = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href*="/products/"]:not(.resume-course__content)')).map(a => a.href);
    });

    linksOnPage.forEach(link => {
      const parts = link.split('/');
      const lastPart = parts[parts.length - 1]; // Extract the last part of the URL
      const courseName = ucwords(lastPart.replace(/-/g, ' ')); // Replace "-" with " " and convert to Title Case
      courseData.set(link, courseName); // Map URL to course name
    });

    // Check for the "next" link
    nextPageUrl = await page.evaluate(() => {
      const nextLink = document.querySelector('a.pag__link.pag__link--next');
      return nextLink ? nextLink.href : null;
    });

  } while (nextPageUrl);

  // Convert the Map to an array of objects
  return Array.from(courseData.entries()).map(([url, name]) => ({ url, name }));
}

async function getPaginationInfo(page) {
  const paginationInfo = await page.evaluate(() => {
    const pageLinks = Array.from(document.querySelectorAll('a[href*="page="]'));
    return {
      totalPages: pageLinks.length,
      pageUrls: pageLinks.map(link => link.href),
    };
  });

  return paginationInfo;
}
async function getLegacyStructure(page, courseUrl) {
  console.log('getLegacyStructure');
  const currentUrl = page.url();
  const isLoginPage = currentUrl.includes('/login') || currentUrl.includes('/sign_in') || await page.$('input[type="password"]');
  if (isLoginPage) {
    throw new Error(`Authentication required: Redirected to login page (${currentUrl}) when accessing legacy course structure.`);
  }

  const courseTitle = await page.evaluate(() => {
    const el =
      document.querySelector('h1') ||
      document.querySelector('h2.product_title_top');

    return el ? el.textContent.trim() : null;
  });
  console.log(`Course Title: ${courseTitle}`);

  if (!courseTitle || /^(zaloguj się|log in|sign in|login|sign up)$/i.test(courseTitle.trim())) {
    throw new Error(`Authentication required: Encountered login/unauthorized page ("${courseTitle || 'Unknown'}") instead of course contents.`);
  }

  await page.goto(courseUrl + "/categories", { waitUntil: "networkidle0" });

  const catUrl = page.url();
  if (catUrl.includes('/login') || catUrl.includes('/sign_in') || await page.$('input[type="password"]')) {
    throw new Error(`Authentication required: Access to course categories redirected to login page (${catUrl}).`);
  }

  // Extract modules
  console.log("Retrieving modules...");
  const modules = await getModules(page, courseUrl);

  if (!modules || modules.length === 0) {
    throw new Error(`No course modules found for "${courseTitle}" at ${courseUrl}. Ensure this course is enrolled and accessible.`);
  }

  const structure = { [courseTitle]: {} };

  let modCounter = 1;
  let globalLessonCounter = 1;

  for (const module of modules) {
    const formattedModTitle = `M${String(modCounter).padStart(2, '0')} - ${module.title}`;
    console.log(`Processing module: ${formattedModTitle}`);
    const lessons = await getLessons(page, module.url);

    structure[courseTitle][formattedModTitle] = lessons.map((lesson) => {
      const formattedLessonTitle = `${String(globalLessonCounter).padStart(3, '0')} - ${formattedModTitle} - ${lesson.title}`;
      globalLessonCounter++;
      return {
        title: formattedLessonTitle,
        url: lesson.url,
        "video url(s)": [],
        referer: lesson.url,
        html: null,
        downloads: [],
      };
    });
    modCounter++;
  }

  return structure;
}

async function getAllPages(page, baseUrl, selector) {
  let allUrls = new Set(); // Use a set to avoid duplicates
  let currentPage = 1;

  while (true) {
    const url = `${baseUrl}?page=${currentPage}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Add all pagination links from the current page
    const pageLinks = await page.$$eval(selector, (elements) =>
      elements
        .map((el) => el.href)
        .filter((href) => href.includes("?page="))
    );

    // Add links to the set and stop if no new links found
    const previousSize = allUrls.size;
    pageLinks.forEach((link) => allUrls.add(link));
    if (allUrls.size === previousSize) break;

    currentPage++;
  }

  if (allUrls.size === 0) {
    allUrls.add(baseUrl);
  }

  return Array.from(allUrls);
}

async function getModules(page, baseUrl) {
  console.log('getting modules for ' + baseUrl);
  let url = await page.url();
  const modulePages = await getAllPages(page, url, 'a[href*="?page="]');
  const modules = [];

  for (const pageUrl of modulePages) {
    console.log(`Processing module page: ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: "networkidle2" });

    const pageModules = await page.$$eval("div.syllabus__item", (items) =>
      items.map((item) => {
        const link = item.querySelector("a");
        const title = item.querySelector("p.syllabus__title");
        return link && title
          ? { url: link.href.trim(), title: title.textContent.trim() }
          : null;
      }).filter(Boolean)
    );

    modules.push(...pageModules);
  }

  return modules;
}

async function getLessons(page, moduleUrl) {
  const lessonPages = await getAllPages(page, moduleUrl, 'a[href*="?page="]');
  const lessons = [];

  for (const pageUrl of lessonPages) {
    console.log(`Processing lessons page: ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

    const pageLessons = await page.$$eval("div.syllabus__item", (items) =>
      items.map((item) => {
        const link = item.querySelector("a");
        const title = item.querySelector("p.syllabus__title");
        return link && title
          ? { url: link.href.trim(), title: title.textContent.trim() }
          : null;
      }).filter(Boolean)
    );

    lessons.push(...pageLessons);
  }
  if (lessons.length === 0) {
    //post_list_item
    for (const pageUrl of lessonPages) {
      console.log(`Processing lessons page: ${pageUrl}`);
      await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

      const pageLessons = await page.$$eval(
        "div.post_list_item",
        items =>
          items.flatMap(item => {
            const titleEl = item.querySelector("a.post_item_title");
            const containerTitle = titleEl?.textContent?.trim() || null;

            const subLinks = Array.from(
              item.querySelectorAll(".pp_list .l_post a")
            );

            if (subLinks.length > 1) {
              return subLinks.map(a => ({
                url: new URL(a.getAttribute("href"), window.location.origin).href,
                title: a.textContent.trim(),
              }));
            }

            const linkEl =
              subLinks[0] ||
              titleEl;

            if (!linkEl) return [];

            return [{
              url: new URL(linkEl.getAttribute("href"), window.location.origin).href,
              title: containerTitle || linkEl.textContent.trim()
            }];
          })
      );

      lessons.push(...pageLessons);
    }
  }


  console.log('found ' + lessons.length + " lesson(s)");

  return lessons;
}


async function getStructure(page, courseUrl) {
  console.log('Extracting course structure...');
  await page.goto(courseUrl, { waitUntil: 'domcontentloaded' });
  const baseUrl = new URL(page.url()).origin;

  const currentUrl = page.url();
  const isLoginPage = currentUrl.includes('/login') || currentUrl.includes('/sign_in') || await page.$('input[type="password"]');
  if (isLoginPage) {
    throw new Error(`Authentication required: Access to course (${courseUrl}) was redirected to login page (${currentUrl}). Please verify your credentials or session cookies.`);
  }

  structure = await page.evaluate((baseUrl) => {
    const courseTitleElement =
      document.querySelector('.product-title h1') ||
      document.querySelector('h1.panel__title');

    const courseTitle = courseTitleElement
      ? courseTitleElement.textContent.trim()
      : 'Untitled Course';

    const structure = { [courseTitle]: {} };

    let moduleCounter = 1;
    let lessonCounter = 1;

    const lessonLinks = document.querySelectorAll('a.product-outline-post');
    const lessonNumberDigits = lessonLinks.length >= 100 ? 3 : 2;

    function processDropdown(dropdown) {
      const header =
        dropdown.querySelector(
          ':scope > h3.product-outline-category, :scope > h3.product-outline-subcategory'
        );

      if (!header) return;

      const moduleTitle = header.textContent.trim();
      const moduleName = `M${String(moduleCounter).padStart(2, '0')} - ${moduleTitle}`;
      moduleCounter++;

      structure[courseTitle][moduleName] = [];

      const content = dropdown.querySelector(':scope > .dropdown-content');
      if (!content) return;

      Array.from(content.children).forEach((el) => {

        if (el.matches('a.product-outline-post')) {
          const lessonTitle =
            el.querySelector('.media-body')?.textContent.trim() ||
            'Untitled Lesson';

          const lessonUrl = new URL(el.getAttribute('href'), baseUrl).href;

          structure[courseTitle][moduleName].push({
            title: `${String(lessonCounter).padStart(lessonNumberDigits, '0')} - ${moduleName} - ${lessonTitle}`,
            url: lessonUrl,
            referer: null,
            "video url(s)": [],
            html: null,
            downloads: [],
          });

          lessonCounter++;
        }

        if (el.matches('.dropdown.navidropdown')) {
          processDropdown(el);
        }
      });
    }

    const allDropdowns = document.querySelectorAll('.dropdown.navidropdown');

    allDropdowns.forEach(dropdown => {
      if (!dropdown.closest('.dropdown-content')) {
        processDropdown(dropdown);
      }
    });

    return structure;
  }, baseUrl);

  const courseTitle = Object.keys(structure)[0];
  const isEmpty = Object.keys(structure[courseTitle]).length === 0;

  if (isEmpty) {
    return getLegacyStructure(page, courseUrl);
  }
  return structure;
}






async function scrapLessonData(page, structure, savePath) {
  //	page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  for (const courseTitle in structure) {
    const modules = structure[courseTitle];
    for (const moduleName in modules) {
      const lessons = modules[moduleName];
      for (const lesson of lessons) {
        if (!lesson.url || (lesson.url && (lesson.scraped || (lesson.html && (lesson["video url(s)"]?.length > 0 || lesson.downloads?.length > 0))))) continue;
        console.log(`Processing lesson: ${lesson.title} (${lesson.url})`);
        await page.goto(lesson.url, { waitUntil: 'domcontentloaded' });

        // Wait for the JSON-LD script to load
        try {
          await page.waitForSelector('script.w-json-ld', { timeout: 3000 });
        } catch {
          console.log('No Wistia script found on the page.');
        }

        // Extract video data
        const videoData = await page.evaluate(() => {
          const script = document.querySelector('script.w-json-ld');
          if (!script) {
            console.log('No script with class "w-json-ld" found.');
            return null;
          }

          try {
            const data = JSON.parse(script.textContent);
            const wistiaId = new URL(data.embedUrl).pathname.split('/').pop();
            const mp4Url = data.contentUrl.includes(".m3u8") ? data.contentUrl.replace('.m3u8', '.mp4') : data.contentUrl.replace('.bin', '.mp3');
            return {
              wistiaId,
              mp4Url,
              jsonUrl: `https://fast.wistia.com/embed/medias/${wistiaId}.json`,
            };
          } catch (error) {
            console.error('Failed to parse Wistia JSON-LD:', error);
            return null;
          }
        });

        if (videoData) {
          lesson["video url(s)"].push(videoData.mp4Url);
          lesson.jsonUrl = videoData.jsonUrl;
          //          console.log(`Found Wistia video: ${videoData.jsonUrl}`);
        }

        // Extract lesson content HTML
        const contentHtml = await page.evaluate(() => {
          let contentDiv = document.querySelector('.main-content-container');
          if (!contentDiv) {
            contentDiv = document.querySelector('div.panel__block');
          }
          if (!contentDiv) {
            contentDiv = document.querySelector('div.p_sectiono');
          }
          if (!contentDiv) {
            return null;
          }

          const contentText = contentDiv.innerText.trim();
          if (contentText.length <= 50) {
            console.log('Content is too short, skipping save.');
            return null;
          }

          return contentDiv.outerHTML;
        });
        lesson.html = contentHtml;

        try {
          let downloadLinks = [];

          // 1. If download trigger button exists, trigger click in browser context
          const downloadButton = await page.$('a.downloads-trigger, [kjb-settings-id*="downloads"]');
          if (downloadButton) {
            await page.evaluate(el => el.click(), downloadButton);

            // Wait briefly for dropdown menu / links to mount (without requiring .show class!)
            try {
              await page.waitForSelector(
                'div.downloads-dropdown a.downloads-link, a.downloads-link, a[href*="/courses/downloads/"]',
                { timeout: 2500 }
              );
            } catch (e) {}

            downloadLinks = await page.$$eval(
              'a.downloads-link.media, a.downloads-link, div.downloads-dropdown a[href]',
              links =>
                links.map(link => ({
                  href: link.href,
                  text:
                    (link.querySelector('.media-body')?.textContent || link.textContent || '').trim() ||
                    'download'
                }))
            );
          }

          // 2. Direct DOM check if links are already rendered or trigger was absent
          if (!downloadLinks.length) {
            downloadLinks = await page.$$eval(
              'a.downloads-link, a[href*="/courses/downloads/"], div.downloads a[href]',
              links =>
                links.map(link => ({
                  href: link.href,
                  text:
                    (link.querySelector('.media-body')?.textContent || link.textContent || '').trim() ||
                    'download'
                }))
            );
          }

          // 3. Fallback for older themes / sections
          if (!downloadLinks.length) {
            const downloadDiv = await page.$('div.downloads');
            if (downloadDiv) {
              downloadLinks = await page.$$eval(
                'a.downloads__download, div.downloads a[href]',
                links =>
                  links.map(link => ({
                    href: link.href,
                    text:
                      (link.querySelector('.media-body')?.textContent || link.textContent || '').trim() ||
                      'download'
                  }))
              );
            }
          }

          if (!downloadLinks.length) {
            downloadLinks = await page.$$eval(
              'div.p_section',
              sections =>
                sections
                  .filter(section => {
                    const heading = (section.querySelector('h3.p_heading, .p_heading')?.textContent || '').toLowerCase();
                    return heading.includes('pliki do pobrania') || heading.includes('download') || heading.includes('material');
                  })
                  .flatMap(section =>
                    Array.from(section.querySelectorAll('a.post_ddl, a[href]')).map(a => ({
                      href: a.href,
                      text: (a.textContent || '').trim() || 'download'
                    }))
                  )
            );
          }

          // Filter out hash/javascript links and deduplicate
          const validDownloads = [];
          const seenHrefs = new Set();
          for (const dl of downloadLinks) {
            if (!dl.href || dl.href === '#' || dl.href.startsWith('javascript:')) continue;
            if (!seenHrefs.has(dl.href)) {
              seenHrefs.add(dl.href);
              validDownloads.push(dl);
            }
          }

          if (validDownloads.length > 0) {
            console.log(`Found ${validDownloads.length} download link(s).`);
            lesson.downloads = validDownloads;
          }

        } catch (error) {
          console.error('Error extracting download links:', error.message || error);
        }

        lesson.scraped = true;




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
  id: 'kajabi',
  name: 'Kajabi',
  domains: ["mykajabi.com", "kajabi.com"],
  detectionKeywords: ["kajabi"],
  authMethods: ["cookies", "credentials"],
  login,
  getCourses,
  getStructure,
  scrapLessonData
};
