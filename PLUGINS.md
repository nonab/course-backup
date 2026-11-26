# Platform Plugin Guide (Adapters)

Course Backup features a modular autoloader architecture. Each platform is an isolated adapter in `src/platforms/`. The platform registry discovers and registers plugins automatically.

---

## Anatomy of a Platform Adapter

A platform adapter is a Node.js module exporting:
1. `metadata`: Identification and matching rules.
2. Standard lifecycle functions:
   - `login(page, credentials)`: Authentication handling.
   - `getCourses(page, baseUrl, platformUrl)`: Discovery of accessible courses.
   - `getStructure(page, courseUrl)`: Extraction of modules and lesson links.
   - `scrapLessonData(page, structure, savePath)`: Detail scraping for each lesson (videos, texts, downloadable files).

---

## Step-by-Step: Adding a New Platform

### 1. Copy the Template
Copy `src/platforms/templatePlatformFunctions.js` into a new file matching the naming convention:
```bash
cp src/platforms/templatePlatformFunctions.js src/platforms/platformMyLmsFunctions.js
```

### 2. Define Metadata
At the top of your adapter file, specify:
```javascript
const metadata = {
  id: 'mylms',
  name: 'MyLMS Platform',
  version: '1.0.0',
  domains: ['mylms.com', 'app.mylms.com'],
  urlPatterns: [/https?:\/\/[^/]+\.mylms\.com/i],
  detectionKeywords: ['mylms-player', 'data-mylms-course'],
  authMethods: ['credentials', 'cookies']
};
```

### 3. Implement Lifecycle Functions

#### `login(page, { username, password, url, baseUrl })`
Handles navigation to the login page, filling credentials, and waiting for authentication tokens or cookies.

#### `getCourses(page, baseUrl, platformUrl)`
Navigates to the user's course library / dashboard and returns an array of courses:
```javascript
return [
  { name: 'Course Title 1', url: 'https://app.mylms.com/courses/1' },
  { name: 'Course Title 2', url: 'https://app.mylms.com/courses/2' }
];
```

#### `getStructure(page, courseUrl)`
Loads the course page and returns the course hierarchy:
```javascript
return {
  "Course Title": {
    "Module 1 - Introduction": [
      { title: "Lesson 1", url: "https://..." },
      { title: "Lesson 2", url: "https://..." }
    ]
  }
};
```

#### `scrapLessonData(page, structure, savePath)`
You can leverage the built-in `extractVideoUrls(page)` and `extractDownloadLinks(page)` helpers from `../core/extractors` to automatically discover videos (Vimeo, YouTube, Hotmart, Wistia, BunnyCDN, Kaltura, Cloudflare Stream, HTML5):
```javascript
const { extractVideoUrls, extractDownloadLinks } = require('../core/extractors');

// Inside scrapLessonData loop:
lesson["video url(s)"] = await extractVideoUrls(page);
lesson.downloads = await extractDownloadLinks(page);
```

Iterates over lessons in the structure, visits lesson pages, extracts video URLs, embed iframes (Vimeo, YouTube, Wistia, HLS), HTML contents, and download links.

---

## Automatic Discovery & Testing

Once created in `src/platforms/`, your adapter is automatically detected by the registry:
- CLI test: `npm run cli -- https://your-lms-url.com`
- GUI: Your platform will appear in the platform selector in the Desktop App.

---

## Don't want to code it yourself?

If you need support for an unsupported LMS or course platform and prefer the author to implement and test the adapter for you:  
👉 **[Request a Custom Platform Adapter on Ko-fi](https://ko-fi.com/nonab/commissions?commissionAlias=df83097268#buyShopCommissionModal)**
