const { extractVideoUrls } = require('../core/extractors');
const { loginWordPress } = require('../core/wordpressAuth');
const fs = require('fs');
const path = require('path');

async function login(page, credentials) {
  console.log('Logging into WP Courseware platform via WordPress Auth...');
  return await loginWordPress(page, credentials);
}

async function getCourses(page, baseUrl) {
	console.log('Fetching available courses from:', baseUrl);
	const courses = [];

	// Get all <a> hrefs that match baseUrl pattern and are longer than base
	const courseUrls = await page.$$eval('a', (anchors, base) => {
		return anchors
			.map(a => a.href.trim())
			.filter(href => href.startsWith(base) && href.length > base.length);
	}, baseUrl);

	// Remove duplicates
	const uniqueUrls = [...new Set(courseUrls)];

	for (const href of uniqueUrls) {
		try {
			await page.goto(href, { waitUntil: 'networkidle2' });

			const hasAccess = await page.evaluate(() => {
				const membersOnlySpan = document.querySelector('span.tva-cm-members-only');
				const noPrivilegesText = Array.from(document.querySelectorAll('p'))
					.some(p => p.textContent.trim().includes('You do not have the correct privileges to access this content.'));
				return !(membersOnlySpan || noPrivilegesText);
			});

			if (hasAccess) {
				const title = await page.title();
				const courseName = title.split(' - ')[0].trim();
				courses.push({ name: courseName, url: href });
			} 
		} catch (err) {
			console.error(`❌ Błąd przy przetwarzaniu ${href}: ${err.message}`);
		}
	}

	return courses;
}

function addZeroPrefix(num) {
  return num < 10 ? `0${num}` : num;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

async function getStructure(page, courseUrl) {
    await page.goto(courseUrl, { waitUntil: "networkidle2" });
	const rawTitle = await page.title();
	const courseTitle = rawTitle.split(' - ')[0].trim();
	const structure = {};
	structure[courseTitle] = {};

	// Get table rows
	const rows = await page.$$eval('table#wpcw_fe_course tr', trs => {
		const data = [];
		let currentModule = null;

		for (const tr of trs) {
			if (tr.classList.contains('wpcw_fe_module')) {
				// New module
				const moduleTitleEl = tr.querySelector('th.wpcw_fe_module_desc_header');
				if (moduleTitleEl) {
					currentModule = moduleTitleEl.textContent.trim();
					data.push({ module: currentModule, lessons: [] });
				}
			} else if (tr.classList.contains('wpcw_fe_unit')) {
				// Lesson
				const link = tr.querySelector('td.wpcw_fe_unit a');
				if (link && currentModule) {
					const lessonTitle = link.textContent.trim();
					const lessonUrl = link.href.trim();

					// Push lesson to the last module's lesson array
					const lastModule = data[data.length - 1];
					lastModule.lessons.push({ title: lessonTitle, url: lessonUrl });
				}
			}
		}
	
		return data;
	});

	// Transform list of modules + lessons to expected structure
	for (const module of rows) {
		structure[courseTitle][module.module] = module.lessons;
	}
	console.dir(structure, { depth: null });
    return structure;
}

// Helper functions
const MAX_RETRIES = 5; // Number of retries for each operation
const RETRY_DELAY = 5000; // Delay (ms) between retries

async function safeEvaluate(page, callback, ...args) {
    let attempts = 0;
    while (attempts < MAX_RETRIES) {
        try {
            return await page.evaluate(callback, ...args);
        } catch (error) {
            attempts++;
            console.error(`Attempt ${attempts} failed: ${error.message}`);
            if (attempts >= MAX_RETRIES) {
                throw new Error(`Operation failed after ${MAX_RETRIES} attempts.`);
            }
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        }
    }
}
async function scrapLessonData(page, structure, savePath) {
  for (const courseTitle in structure) {
    const modules = structure[courseTitle];

    for (const moduleName in modules) {
      const lessons = modules[moduleName];

      for (const lesson of lessons) {
        console.log(`Processing lesson: ${lesson.title}`);
        await page.goto(lesson.url, { waitUntil: 'domcontentloaded' });

        // Extract video URLs from iframe elements
lesson["video url(s)"] = await extractVideoUrls(page);
          let contentHtml = await safeEvaluate(page, () => {
          let contentDiv = document.querySelector('.wpcw-unit-desc');
            if (!contentDiv) { //legacy
                contentDiv = document.querySelector('div.content_lekcji');
            }
          if (!contentDiv) {
            return null;
          }
          
          return contentDiv.outerHTML;
        });
		
        if(contentHtml) {
            lesson.html = contentHtml;
        }
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
  id: 'courseware',
  isWordPress: true,
  name: 'WP Courseware LMS',
  domains: [],
  detectionKeywords: ["wp-courseware","wpcw"],
  authMethods: ["cookies","credentials"],
  login,
  getCourses,
  getStructure,
  scrapLessonData
};
