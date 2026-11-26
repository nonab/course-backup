const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { CourseBackupEngine } = require('../core/engine');
const platforms = require('../platforms');
const downloader = require('../core/downloader');
const { findCookieFile, getCookiesDir } = require('../core/cookieManager');

function toLongPath(p) {
  if (!p || typeof p !== 'string') return p;
  try {
    if (fs.existsSync(p)) {
      return fs.realpathSync.native(p);
    }
  } catch (e) { }
  return p;
}

function parseCourseJsonManifest(rawPath) {
  if (!rawPath) return null;
  const filePath = toLongPath(rawPath);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const courseTitles = Object.keys(parsed);
    const ext = path.extname(filePath);
    const courseName = courseTitles.length > 0 ? courseTitles[0] : path.basename(filePath, ext);
    let lessonCount = 0;
    if (parsed && typeof parsed === 'object') {
      for (const cName in parsed) {
        const modules = parsed[cName];
        if (modules && typeof modules === 'object') {
          for (const mName in modules) {
            const lessons = modules[mName];
            if (Array.isArray(lessons)) lessonCount += lessons.length;
          }
        }
      }
    }
    return { filePath, courseName, lessonCount };
  } catch (e) {
    const ext = path.extname(filePath);
    return { filePath, courseName: path.basename(filePath, ext), lessonCount: 0 };
  }
}

let mainWindow;
let currentEngine = null;

function cleanupAllProcesses() {
  try {
    downloader.killAllDownloadProcesses();
  } catch (e) { }

  if (currentEngine) {
    try {
      const bProc = currentEngine.browser?.process();
      if (bProc) downloader.killProcessTree(bProc);
      currentEngine.cancel();
    } catch (e) { }
    currentEngine = null;
  }
}

process.on('exit', () => {
  cleanupAllProcesses();
});

process.on('SIGINT', () => {
  cleanupAllProcesses();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanupAllProcesses();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  try {
    const logPath = path.resolve(process.cwd(), 'output', 'course-backup.log');
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] [CRASH] ${err.stack || err.message}\n`);
  } catch (e) { }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('archive-log', { message: `Fatal: ${err.message}`, type: 'error' });
    mainWindow.webContents.send('archive-complete', { success: false });
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
  try {
    const logPath = path.resolve(process.cwd(), 'output', 'course-backup.log');
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] [REJECTION] ${reason}\n`);
  } catch (e) { }
});

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 840,
    minHeight: 580,
    title: 'Course Backup - Course Migration Tool',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#090d16',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.removeMenu();

  // Terminate any active background child processes before the window is destroyed
  mainWindow.on('close', () => {
    cleanupAllProcesses();
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Forward renderer console logs to terminal stdout
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (level >= 2) {
      console.warn(`[UI Console] ${message}`);
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  cleanupAllProcesses();
});

app.on('will-quit', () => {
  cleanupAllProcesses();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC Handler: Select download / export directory
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : toLongPath(result.filePaths[0]);
});

// IPC Handler: Get default output directory
ipcMain.handle('get-default-path', () => {
  const defaultDir = toLongPath(path.resolve(process.cwd(), 'output'));
  if (!fs.existsSync(defaultDir)) {
    fs.mkdirSync(defaultDir, { recursive: true });
  }
  return defaultDir;
});

// IPC Handler: Get supported platforms from autoloader
ipcMain.handle('get-platforms', () => {
  return platforms.getAll().map(p => ({
    id: p.id,
    name: p.name,
    domains: p.domains || [],
    detectionKeywords: p.detectionKeywords || [],
    authMethods: p.authMethods || []
  }));
});

// IPC Handler: Select cookies JSON file
ipcMain.handle('select-cookies-file', async () => {
  const cookiesDir = toLongPath(getCookiesDir(process.cwd()));
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Cookies JSON File',
    defaultPath: cookiesDir,
    filters: [{ name: 'JSON Cookies', extensions: ['json'] }],
    properties: ['openFile']
  });
  return result.canceled ? null : toLongPath(result.filePaths[0]);
});

// IPC Handler: Select course JSON manifest
ipcMain.handle('select-course-json', async () => {
  const defaultOutputPath = toLongPath(path.resolve(process.cwd(), 'output'));
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Course Manifest JSON File',
    defaultPath: defaultOutputPath,
    filters: [{ name: 'Course Manifest (JSON)', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return parseCourseJsonManifest(result.filePaths[0]);
});

// IPC Handler: Parse course JSON from dropped path or direct input
ipcMain.handle('parse-course-json', async (event, inputPath) => {
  return parseCourseJsonManifest(inputPath);
});

// IPC Handler: Check yt-dlp and ffmpeg media dependencies
ipcMain.handle('check-dependencies', async () => {
  const { checkMediaDependencies } = require('../core/downloader');
  return await checkMediaDependencies();
});

// IPC Handler: Smart wildcard cookies finder
ipcMain.handle('find-cookies-file', (event, { url, platformId }) => {
  return findCookieFile(url, platformId, process.cwd());
});

// IPC Handler: Open cookies directory in OS file explorer
ipcMain.handle('open-cookies-folder', async () => {
  const cookiesDir = toLongPath(getCookiesDir(process.cwd()));
  return await shell.openPath(cookiesDir);
});

// IPC Handler: Open directory in OS file explorer
ipcMain.handle('open-path', async (event, targetPath) => {
  const p = toLongPath(targetPath) || toLongPath(path.resolve(process.cwd(), 'output'));
  if (fs.existsSync(p)) {
    return await shell.openPath(p);
  }
  return false;
});

// IPC Handler: Run batch download script
ipcMain.handle('run-batch-download', async (event, batPath) => {
  batPath = toLongPath(batPath);
  const sendLog = (message, type = 'info') => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('archive-log', { message, type });
    }
  };
  const sendProgress = (percent) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('archive-progress', percent);
    }
  };
  const sendStatus = (state, text = '') => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('archive-status', { state, text });
    }
  };

  const downloader = require('../core/downloader');
  return await downloader.runBatchDownload(batPath, {
    onLog: (line, type) => sendLog(line, type),
    onProgress: (percent) => sendProgress(percent),
    onStatus: (state, text) => sendStatus(state, text)
  });
});

// IPC Handler: Start Migration / Archival process
ipcMain.on('start-archive', async (event, data) => {
  const { url, username, password, mode, downloadPath, cookiesPath } = data;
  const finalOutPath = toLongPath(downloadPath || path.resolve(process.cwd(), 'output'));
  const resolvedCookiesPath = cookiesPath ? toLongPath(cookiesPath) : null;

  const sendLog = (message, type = 'info') => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('archive-log', { message, type });
    }
  };

  const updateProgress = (percent) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('archive-progress', percent);
    }
  };

  const updateStatus = (state, text = '') => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('archive-status', { state, text });
    }
  };

  updateStatus('scraping', 'Initializing Scraper Engine...');

  try {
    currentEngine = new CourseBackupEngine({
      url,
      username: username || '',
      password: password || '',
      mode: mode || 'json',
      outputDir: finalOutPath,
      cookiesPath: cookiesPath || null,
      headless: data.headless !== undefined ? data.headless : true
    });

    currentEngine.on('log', ({ message, type }) => sendLog(message, type));
    currentEngine.on('status', ({ state, text }) => updateStatus(state, text));
    currentEngine.on('progress', (percent) => updateProgress(percent));

    currentEngine.on('courses', (courses) => {
      updateStatus('scraping', 'Select courses to backup...');
      if (mainWindow && !mainWindow.isDestroyed()) {
        const promptLines = courses.map(c => `${c.id} - ${c.name} (${c.url})`).join('\n');
        const promptText = `Select course to download:\n0 - All\n${promptLines}\nEnter course ID to be parsed (0 to parse all, multiple IDs must be comma-delimited): `;
        mainWindow.webContents.send('archive-prompt', { promptText, courses });
      }
    });

    currentEngine.on('completed', (data = {}) => {
      sendLog('Backup exported successfully!', 'success');
      updateProgress(100);
      updateStatus('completed', 'Done');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('archive-complete', { success: true, ...data });
      }
    });

    currentEngine.on('error', (err) => {
      const isUnknownPlatform = !!err.isUnknownPlatform || (err.message && err.message.includes('No matching platform adapter'));
      if (!isUnknownPlatform) {
        sendLog(`Engine error: ${err.message}`, 'error');
      }
      updateStatus('error', isUnknownPlatform ? 'Platform not supported' : 'Error occurred');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('archive-complete', { success: false, isUnknownPlatform });
      }
    });

    await currentEngine.start();

  } catch (err) {
    sendLog(`Fatal error: ${err.message}`, 'error');
    updateStatus('error', err.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('archive-complete', { success: false });
    }
  } finally {
    currentEngine = null;
  }
});

// IPC Handler: Start Download directly from local course.json manifest
ipcMain.on('start-from-json', async (event, data) => {
  let { jsonPath, downloadPath, audioOnly } = data;
  jsonPath = toLongPath(jsonPath);
  if (downloadPath) downloadPath = toLongPath(downloadPath);

  const sendLog = (message, type = 'info') => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('archive-log', { message, type });
    }
  };
  const sendProgress = (percent) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('archive-progress', percent);
    }
  };
  const sendStatus = (state, text = '') => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('archive-status', { state, text });
    }
  };

  try {
    sendStatus('downloading', 'Preparing download tasks...');
    sendLog(`Loading local course manifest: ${jsonPath}`, 'info');

    // Determine target directory: use user-selected downloadPath, or default to folder containing the JSON
    const targetDir = (downloadPath && downloadPath.trim())
      ? toLongPath(path.resolve(downloadPath.trim()))
      : path.dirname(jsonPath);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    sendLog(`Target directory: ${targetDir}`, 'info');

    // Check if manifest contains attached downloadable files & extract HTML lesson contents
    const { saveLessonHtml } = require('../core/downloader');
    let downloadableCount = 0;
    let htmlExtractedCount = 0;

    try {
      const raw = fs.readFileSync(jsonPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const cName in parsed) {
          const modules = parsed[cName];
          if (modules && typeof modules === 'object') {
            for (const mName in modules) {
              const lessons = modules[mName];
              if (Array.isArray(lessons)) {
                for (const l of lessons) {
                  // Count materials / attachments
                  if (Array.isArray(l.downloads) && l.downloads.length > 0) {
                    downloadableCount += l.downloads.length;
                  } else if (Array.isArray(l.attachments) && l.attachments.length > 0) {
                    downloadableCount += l.attachments.length;
                  }

                  // Extract HTML lesson content if present
                  if (l.html && typeof l.html === 'string' && l.html.trim()) {
                    try {
                      saveLessonHtml(l.html, l.title, targetDir);
                      htmlExtractedCount++;
                    } catch (e) {
                      console.warn(`Could not save HTML for ${l.title}:`, e.message);
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch (_) { }

    if (htmlExtractedCount > 0) {
      sendLog(`Extracted ${htmlExtractedCount} HTML lesson file(s) into course directory.`, 'success');
    }

    const { processJsonFile } = require('../core/jsonToBat');
    const result = await processJsonFile(jsonPath, null, {
      audioOnly: !!audioOnly,
      outputDir: targetDir
    });
    const batPath = result?.batPath || (typeof result === 'string' ? result : null);

    if (!batPath || !fs.existsSync(batPath)) {
      if (result && result.totalCommands === 0) {
        sendLog('No video or audio media tasks found in this course manifest.', 'info');
        if (downloadableCount > 0) {
          sendLog(`There were ${downloadableCount} downloadable file(s) attached to lessons that were not downloaded. Use the standard process with login & password to make this possible.`, 'warning');
        }
        sendLog('All lesson HTML and materials for this course are already complete.', 'success');
        sendProgress(100);
        sendStatus('completed', 'Done');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('archive-complete', {
            success: true,
            isFromJson: true,
            outputDir: targetDir
          });
        }
        return;
      }
      throw new Error(`Failed to generate batch download script for: ${jsonPath}`);
    }

    sendLog(`Download batch script generated: ${batPath}`, 'success');
    sendStatus('downloading', 'Downloading media assets...');

    const downloader = require('../core/downloader');
    const success = await downloader.runBatchDownload(batPath, {
      onLog: (line, type) => sendLog(line, type),
      onProgress: (percent) => sendProgress(percent),
      onStatus: (state, text) => sendStatus(state, text)
    });

    if (success !== false) {
      if (downloadableCount > 0) {
        sendLog(`There were ${downloadableCount} downloadable file(s) attached to lessons that were not downloaded. Use the standard process with login & password to make this possible.`, 'warning');
      }
      sendProgress(100);
      sendStatus('completed', 'Done');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('archive-complete', {
          success: true,
          isFromJson: true,
          outputDir: targetDir,
          batPaths: [batPath]
        });
      }
    } else {
      sendLog('Download was stopped by user.', 'warning');
      sendStatus('idle', 'Stopped');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('archive-complete', { success: false });
      }
    }
  } catch (err) {
    sendLog(`Error: ${err.message}`, 'error');
    sendStatus('error', err.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('archive-complete', { success: false });
    }
  }
});

// IPC Handler: Send prompt response back to engine
ipcMain.on('archive-prompt-response', (event, input) => {
  if (currentEngine) {
    currentEngine.selectCourses(input);
  }
});

// IPC Handler: Cancel active migration process or batch download
ipcMain.on('cancel-archive', () => {
  cleanupAllProcesses();
});

// IPC Handler: Cancel batch download explicitly
ipcMain.handle('cancel-batch-download', () => {
  cleanupAllProcesses();
  return true;
});
