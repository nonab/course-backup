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

  const emailSelector = 'input[type="email"], input[name="email"], input[name="member[email]"], input[type="text"], #member_email';
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
  await page.type('input[type="password"], input[name="member[password]"], #member_password', password);

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
async function getAllPages(page, baseUrl, selector) {
  const allUrls = new Set([baseUrl]);
  let currentPage = 1;
  while (true) {
    await page.goto(`${baseUrl}?page=${currentPage}`, { waitUntil: "domcontentloaded" });
    const pageLinks = await page.$$eval(selector, els => els.map(el => el.href).filter(h => h.includes("?page=")));
    const prevSize = allUrls.size;
    pageLinks.forEach(link => allUrls.add(link));
    if (allUrls.size === prevSize) break;
    currentPage++;
  }
  return Array.from(allUrls);
}

async function getModules(page, baseUrl) {
  console.log('getting modules for ' + baseUrl);
  const modulePages = await getAllPages(page, page.url(), 'a[href*="?page="]');
  const modules = [];

  for (const pageUrl of modulePages) {
    await page.goto(pageUrl, { waitUntil: "networkidle2" });
    const pageMods = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll(
        'div.syllabus__item, .category-card, .card, [class*="category"], .post_list_item'
      ));
      const found = [];
      const seen = new Set();
      for (const el of items) {
        const a = el.matches('a[href*="/categories/"]') ? el : el.querySelector('a[href*="/categories/"], a');
        if (!a || !a.href || a.href.endsWith('/categories') || a.href.endsWith('/categories/') || a.href.includes('#')) continue;
        const titleEl = el.querySelector('p.syllabus__title, h2, h3, .title, [class*="title"]') || a;
        const title = titleEl ? titleEl.textContent.trim() : '';
        if (title && !seen.has(a.href)) {
          seen.add(a.href);
          found.push({ url: a.href, title });
        }
      }
      return found;
    });
    modules.push(...pageMods);
  }

  return modules.filter((m, i, arr) => arr.findIndex(x => x.url === m.url) === i);
}

async function getLessons(page, moduleUrl) {
  const lessonPages = await getAllPages(page, moduleUrl, 'a[href*="?page="]');
  const lessons = [];

  for (const pageUrl of lessonPages) {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    const pageLessons = await page.evaluate(() => {
      // 1. Syllabus items (motyw klasyczny)
      const syllabusItems = Array.from(document.querySelectorAll('div.syllabus__item'));
      if (syllabusItems.length > 0) {
        return syllabusItems.map(item => {
          const a = item.querySelector('a');
          const titleEl = item.querySelector('p.syllabus__title');
          return a && titleEl ? { url: a.href, title: titleEl.textContent.trim() } : null;
        }).filter(Boolean);
      }

      // 2. Post list items (motyw z listą postów i kontenerami)
      const postListItems = Array.from(document.querySelectorAll('div.post_list_item'));
      if (postListItems.length > 0) {
        return postListItems.flatMap(item => {
          const titleEl = item.querySelector('a.post_item_title');
          const containerTitle = titleEl?.textContent?.trim() || null;
          const subLinks = Array.from(item.querySelectorAll('.pp_list .l_post a'));
          if (subLinks.length > 1) {
            return subLinks.map(a => ({ url: a.href, title: a.textContent.trim() }));
          }
          const linkEl = subLinks[0] || titleEl;
          if (!linkEl) return [];
          return [{ url: linkEl.href, title: containerTitle || linkEl.textContent.trim() }];
        });
      }

      // 3. Fallback: uniwersalny skan linków do postów
      const seen = new Set();
      return Array.from(document.querySelectorAll('a.product-outline-post, a[href*="/posts/"]'))
        .filter(a => a.href && a.href.includes('/posts/') && !a.href.includes('#'))
        .map(a => {
          if (seen.has(a.href)) return null;
          seen.add(a.href);
          const title = (a.querySelector('.media-body')?.textContent || a.textContent || '').trim().replace(/\s+/g, ' ');
          return title ? { url: a.href, title } : null;
        })
        .filter(Boolean);
    });
    lessons.push(...pageLessons);
  }

  console.log(`found ${lessons.length} lesson(s)`);
  return lessons;
}

async function getLegacyStructure(page, courseUrl) {
  console.log('getLegacyStructure');
  const courseTitle = await page.evaluate(() => {
    const el = document.querySelector('h1, h2.product_title_top');
    return el ? el.textContent.trim() : null;
  });

  if (!courseTitle || /^(zaloguj się|log in|sign in|login|sign up)$/i.test(courseTitle.trim())) {
    throw new Error(`Authentication required: Encountered login page ("${courseTitle || 'Unknown'}") instead of course contents.`);
  }

  await page.goto(courseUrl + "/categories", { waitUntil: "networkidle0" });
  console.log("Retrieving modules...");
  const modules = await getModules(page, courseUrl);

  if (!modules || modules.length === 0) {
    throw new Error(`No course modules found for "${courseTitle}" at ${courseUrl}. Ensure this course is enrolled and accessible.`);
  }

  const structure = { [courseTitle]: {} };
  let modCounter = 1;
  let globalLessonCounter = 1;

  for (const module of modules) {
    const formattedModTitle = `M${String(modCounter++).padStart(2, '0')} - ${module.title}`;
    console.log(`Processing module: ${formattedModTitle}`);
    const lessons = await getLessons(page, module.url);

    structure[courseTitle][formattedModTitle] = lessons.map(lesson => ({
      title: `${String(globalLessonCounter++).padStart(3, '0')} - ${formattedModTitle} - ${lesson.title}`,
      url: lesson.url,
      "video url(s)": [],
      referer: lesson.url,
      html: null,
      downloads: []
    }));
  }

  return structure;
}

async function getStructure(page, courseUrl) {
  console.log('Extracting course structure...');
  await page.goto(courseUrl, { waitUntil: 'domcontentloaded' });
  const baseUrl = new URL(page.url()).origin;

  const currentUrl = page.url();
  if (currentUrl.includes('/login') || currentUrl.includes('/sign_in') || await page.$('input[type="password"]')) {
    throw new Error(`Authentication required: Access to course (${courseUrl}) was redirected to login page (${currentUrl}). Please verify your credentials or session cookies.`);
  }

  // 1. Ekstrakcja struktury ze strony głównej kursu (motyw dropdown, flat outline oraz bezpośrednie posty)
  const structure = await page.evaluate((baseUrl) => {
    const titleEl = document.querySelector('.product-title h1, h1.panel__title, h1, h2.product_title_top');
    const courseTitle = titleEl ? titleEl.textContent.trim() : 'Untitled Course';
    const struct = { [courseTitle]: {} };

    let modCount = 1;
    let lessonCount = 1;
    let curCategory = '';
    let curModule = '';

    const outlineItems = Array.from(document.querySelectorAll(
      'h3.product-outline-category, h3.product-outline-subcategory, a.product-outline-post'
    ));

    if (outlineItems.length > 0) {
      const postsCount = outlineItems.filter(el => el.matches('a.product-outline-post')).length;
      const digits = postsCount >= 100 ? 3 : 2;

      for (const el of outlineItems) {
        if (el.matches('h3.product-outline-category')) {
          curCategory = el.textContent.trim();
          curModule = curCategory;
        } else if (el.matches('h3.product-outline-subcategory')) {
          const sub = el.textContent.trim();
          curModule = curCategory && curCategory !== sub ? `${curCategory} - ${sub}` : sub;
        } else if (el.matches('a.product-outline-post')) {
          const rawMod = curModule || curCategory || 'Wprowadzenie';
          let modKey = Object.keys(struct[courseTitle]).find(k => k.replace(/^M\d+\s*-\s*/, '') === rawMod);
          if (!modKey) {
            modKey = `M${String(modCount++).padStart(2, '0')} - ${rawMod}`;
            struct[courseTitle][modKey] = [];
          }

          const mediaBody = el.querySelector('.media-body');
          const title = mediaBody ? mediaBody.textContent.trim() : (el.textContent.trim().replace(/\s+/g, ' ') || 'Untitled Lesson');
          const url = new URL(el.getAttribute('href'), baseUrl).href;

          struct[courseTitle][modKey].push({
            title: `${String(lessonCount++).padStart(digits, '0')} - ${modKey} - ${title}`,
            url,
            referer: null,
            "video url(s)": [],
            html: null,
            downloads: []
          });
        }
      }
    } else {
      // Płaski kurs bez outline (bezpośrednie lekcje na stronie głównej)
      const directPosts = Array.from(document.querySelectorAll('a[href*="/posts/"]'))
        .filter(a => !a.href.includes('#') && a.textContent.trim());
      if (directPosts.length > 0) {
        const modKey = `M01 - ${courseTitle}`;
        struct[courseTitle][modKey] = directPosts.map((a, idx) => ({
          title: `${String(idx + 1).padStart(2, '0')} - ${modKey} - ${a.textContent.trim().replace(/\s+/g, ' ')}`,
          url: new URL(a.getAttribute('href'), baseUrl).href,
          referer: null,
          "video url(s)": [],
          html: null,
          downloads: []
        }));
      }
    }

    return struct;
  }, baseUrl);

  const courseTitle = Object.keys(structure)[0];
  if (Object.keys(structure[courseTitle]).length > 0) {
    return structure;
  }

  // 2. Fallback na stary motyw /categories
  return getLegacyStructure(page, courseUrl);
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
