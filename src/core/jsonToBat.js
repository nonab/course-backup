const fs = require('fs');
const path = require('path');
const https = require('https');

// Function to fetch JSON data from URL
const fetchJsonFromUrl = (url) => {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (error) {
                    reject(new Error(`Failed to parse JSON: ${error.message}`));
                }
            });
        }).on('error', (err) => {
            reject(new Error(`Failed to fetch JSON: ${err.message}`));
        });
    });
};

// Function to sanitize file names for Windows
const normalizeDashes = (str) => (str ? str.replace(/[–—]/g, '-') : ''); // convert EN DASH / EM DASH to simple hyphen
const sanitizeFileName = (name) => {
    if (!name || typeof name !== 'string') return '';
    return normalizeDashes(name)
        .replace(/["<>|:*?\\/]/g, ' - ')
        .replace(/\s*-\s*/g, ' - ')
        .replace(/\s+/g, ' ')
        .trim();
};

// Function to check if a title already has a proper prefix (zero-padded like "01 - " or module prefix like "M01 - ")
const hasProperNumberPrefix = (title) => {
    if (!title || typeof title !== 'string') return false;
    const trimmed = title.trim();
    return /^(?:\d{2,}\s*[-_.]\s*|(?:M|Moduł|Module)\s*\d+[\s._\-:])/i.test(trimmed);
};

// Function to clean raw / unpadded prefix if present (e.g. "1. ", "1: ", "1 - ", "1) ")
const cleanOldPrefix = (title) => {
    if (!title || typeof title !== 'string') return '';
    return title.replace(/^\d+\s*[:.)\-_]\s*/, '').trim();
};

// Automatically detect lack of number prefixes and add them to lessons and files
const ensureNumberPrefixes = (jsonData, inputFileName, options = {}) => {
    let resolvedInput = inputFileName;
    try {
        if (fs.existsSync(resolvedInput)) {
            resolvedInput = fs.realpathSync.native(resolvedInput);
        }
    } catch (e) { }

    if (options.noNumbering || options.skipNumbering) {
        return false;
    }

    const allLessons = [];
    for (const [courseName, modulesOrLessons] of Object.entries(jsonData)) {
        if (modulesOrLessons && typeof modulesOrLessons === 'object') {
            for (const [moduleName, lessons] of Object.entries(modulesOrLessons)) {
                if (Array.isArray(lessons)) {
                    for (const lesson of lessons) {
                        if (lesson && typeof lesson === 'object' && typeof lesson.title === 'string') {
                            allLessons.push(lesson);
                        }
                    }
                }
            }
        }
    }

    const totalLessons = allLessons.length;
    if (totalLessons === 0) return false;

    const properlyPrefixedCount = allLessons.filter(l => hasProperNumberPrefix(l.title)).length;
    const ratio = properlyPrefixedCount / totalLessons;

    // If less than 80% have proper 2+ digit zero-padded or module prefixes, prefix them!
    if (ratio >= 0.8) {
        return false;
    }

    console.log(`[jsonToBat] Detected lack of number prefixes in "${path.basename(resolvedInput)}" (${properlyPrefixedCount}/${totalLessons} properly prefixed). Adding prefixes...`);

    const padLength = Math.max(2, totalLessons.toString().length);
    const jsonDir = path.dirname(resolvedInput);
    const legacyVideosDir = path.join(jsonDir, 'videos');
    const legacyAudioDir = path.join(jsonDir, 'audio');
    const legacyHtmlDir = path.join(jsonDir, 'html');

    let lessonCounter = 0;
    let jsonModified = false;
    let renamedCount = 0;

    for (const [courseName, modulesOrLessons] of Object.entries(jsonData)) {
        if (modulesOrLessons && typeof modulesOrLessons === 'object') {
            for (const [moduleName, lessons] of Object.entries(modulesOrLessons)) {
                if (Array.isArray(lessons)) {
                    for (const lesson of lessons) {
                        if (lesson && typeof lesson === 'object' && typeof lesson.title === 'string') {
                            lessonCounter++;
                            const prefix = `${String(lessonCounter).padStart(padLength, '0')} - `;
                            const oldTitle = lesson.title;
                            const rawTitle = cleanOldPrefix(oldTitle) || oldTitle.trim();
                            const newTitle = `${prefix}${rawTitle}`;

                            if (oldTitle !== newTitle) {
                                lesson.title = newTitle;
                                jsonModified = true;

                                // Rename existing media and HTML files if present
                                const oldSanitized = sanitizeFileName(oldTitle);
                                const newSanitized = sanitizeFileName(newTitle);
                                const oldRawSanitized = oldTitle.replace(/["<>|:*?\\/]/g, ' - ');
                                const newRawSanitized = newTitle.replace(/["<>|:*?\\/]/g, ' - ');

                                // Video files (stored in course root jsonDir, also migrate legacy videos/ subfolder)
                                const videoUrls = lesson['video url(s)'] || [];
                                const videoCount = Math.max(1, videoUrls.length);
                                for (let idx = 0; idx < videoCount; idx++) {
                                    const suffix = videoUrls.length > 1 ? ` ${idx + 1}` : '';
                                    const possibleOldVideoNames = [
                                        `${oldSanitized}${suffix}.mp4`,
                                        `${oldRawSanitized}${suffix}.mp4`,
                                    ];
                                    const newVideoPath = path.join(jsonDir, `${newSanitized}${suffix}.mp4`);

                                    for (const dir of [jsonDir, legacyVideosDir]) {
                                        for (const oldName of possibleOldVideoNames) {
                                            const oldVideoPath = path.join(dir, oldName);
                                            if (fs.existsSync(oldVideoPath) && oldVideoPath !== newVideoPath && !fs.existsSync(newVideoPath)) {
                                                try {
                                                    fs.renameSync(oldVideoPath, newVideoPath);
                                                    renamedCount++;
                                                    console.log(`[jsonToBat] Renamed video: "${oldVideoPath}" -> "${path.basename(newVideoPath)}"`);
                                                    break;
                                                } catch (err) {
                                                    console.error(`[jsonToBat] Failed to rename video "${oldName}": ${err.message}`);
                                                }
                                            }
                                        }
                                    }

                                    // Audio files (stored in course root jsonDir, also migrate legacy audio/ subfolder)
                                    const possibleOldAudioNames = [
                                        `${oldSanitized}${suffix}.mp3`,
                                        `${oldRawSanitized}${suffix}.mp3`,
                                    ];
                                    const newAudioPath = path.join(jsonDir, `${newSanitized}${suffix}.mp3`);

                                    for (const dir of [jsonDir, legacyAudioDir]) {
                                        for (const oldName of possibleOldAudioNames) {
                                            const oldAudioPath = path.join(dir, oldName);
                                            if (fs.existsSync(oldAudioPath) && oldAudioPath !== newAudioPath && !fs.existsSync(newAudioPath)) {
                                                try {
                                                    fs.renameSync(oldAudioPath, newAudioPath);
                                                    renamedCount++;
                                                    console.log(`[jsonToBat] Renamed audio: "${oldAudioPath}" -> "${path.basename(newAudioPath)}"`);
                                                    break;
                                                } catch (err) {
                                                    console.error(`[jsonToBat] Failed to rename audio "${oldName}": ${err.message}`);
                                                }
                                            }
                                        }
                                    }
                                }

                                // HTML files (stored in course root jsonDir, also migrate legacy html/ subfolder)
                                const possibleOldHtmlNames = [
                                    `${oldSanitized}.html`,
                                    `${oldRawSanitized}.html`,
                                    `${oldTitle.replace(/["<>|:*?\\/]/g, '_')}.html`,
                                    `${newTitle.replace(/["<>|:*?\\/]/g, '_')}.html`,
                                ];
                                const newHtmlPath = path.join(jsonDir, `${newSanitized}.html`);

                                for (const dir of [jsonDir, legacyHtmlDir]) {
                                    for (const oldName of possibleOldHtmlNames) {
                                        const oldHtmlPath = path.join(dir, oldName);
                                        if (fs.existsSync(oldHtmlPath) && oldHtmlPath !== newHtmlPath && !fs.existsSync(newHtmlPath)) {
                                            try {
                                                fs.renameSync(oldHtmlPath, newHtmlPath);
                                                renamedCount++;
                                                console.log(`[jsonToBat] Renamed HTML: "${oldHtmlPath}" -> "${path.basename(newHtmlPath)}"`);
                                                break;
                                            } catch (err) {
                                                console.error(`[jsonToBat] Failed to rename HTML "${oldName}": ${err.message}`);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Clean up empty legacy directories
    for (const legacyDir of [legacyVideosDir, legacyAudioDir, legacyHtmlDir]) {
        if (fs.existsSync(legacyDir)) {
            try {
                const remaining = fs.readdirSync(legacyDir);
                if (remaining.length === 0) fs.rmdirSync(legacyDir);
            } catch (e) { }
        }
    }

    if (jsonModified) {
        try {
            fs.writeFileSync(resolvedInput, JSON.stringify(jsonData, null, 2), 'utf8');
            console.log(`[jsonToBat] Saved updated JSON with prefixed titles: "${resolvedInput}"`);
            if (renamedCount > 0) {
                console.log(`[jsonToBat] Renamed ${renamedCount} existing media/HTML file(s).`);
            }
        } catch (err) {
            console.error(`[jsonToBat] Error writing updated JSON file "${resolvedInput}": ${err.message}`);
        }
    }

    return jsonModified;
};

// Process a single JSON file
const processJsonFile = async (inputFileName, displayName = null, options = {}) => {
    // Normalize options if displayName is passed as options object or boolean
    let audioOnly = false;
    if (typeof displayName === 'object' && displayName !== null) {
        options = displayName;
        displayName = options.displayName || null;
    }
    if (typeof options === 'boolean') {
        audioOnly = options;
    } else if (options && typeof options === 'object') {
        audioOnly = !!(options.audioOnly || options.audio);
    }

    let resolvedInput = inputFileName;
    try {
        if (fs.existsSync(resolvedInput)) {
            resolvedInput = fs.realpathSync.native(resolvedInput);
        }
    } catch (e) { }

    const targetDir = (options && options.outputDir) ? path.resolve(options.outputDir) : path.dirname(resolvedInput);
    const ext = path.extname(resolvedInput);
    const baseName = path.basename(resolvedInput, ext);
    const baseOutputFile = path.join(targetDir, baseName);
    let outputFile;
    if (audioOnly) {
        outputFile = displayName
            ? `${baseOutputFile}_${displayName}_audio.bat`
            : `${baseOutputFile}_audio.bat`;
    } else {
        outputFile = displayName
            ? `${baseOutputFile}_${displayName}.bat`
            : `${baseOutputFile}.bat`;
    }

    // Read JSON data
    let jsonData;
    try {
        const rawData = fs.readFileSync(resolvedInput, 'utf8');
        jsonData = JSON.parse(rawData);
    } catch (error) {
        console.error(`Error reading or parsing file "${resolvedInput}": ${error.message}`);
        return;
    }

    // Detect lack of number prefixes and add them
    ensureNumberPrefixes(jsonData, resolvedInput, options);

    // Prepare media download commands directly into the course root folder
    const mediaCommands = [];
    const mediaExt = audioOnly ? "mp3" : "mp4";

    let hasHtml = false;
    const processLesson = async (lesson) => {
        const { title, "video url(s)": videoUrls, jsonUrl, html, referer } = lesson;

        if (displayName && jsonUrl) {
            try {
                const fetchedJson = await fetchJsonFromUrl(jsonUrl);
                const assets = fetchedJson.media?.assets;
                if (assets) {
                    const asset = assets.find(asset => asset.display_name === displayName);
                    if (asset && asset.url) {
                        const sanitizedTitle = normalizeDashes(sanitizeFileName(title));
                        mediaCommands.push(`echo [backup-item] ${sanitizedTitle}.${mediaExt}`);
                        if (audioOnly) {
                            mediaCommands.push(`yt-dlp --newline --no-warnings --no-update --progress --console-title -x --audio-format mp3 --postprocessor-args "ExtractAudio:-stats" "${asset.url}" -o "${sanitizedTitle}.${mediaExt}" -N 4`);
                        } else {
                            mediaCommands.push(`curl "${asset.url}" -o "${sanitizedTitle}.${mediaExt}"`);
                        }
                    }
                }
            } catch (error) {
                console.error(`Error fetching JSON from URL "${jsonUrl}": ${error.message}`);
            }
        } else if (videoUrls && videoUrls.length > 0) {
            // Deduplicate URLs and clean HTML entities (&amp; -> &)
            const cleanVideoUrls = [];
            const seenKeys = new Set();
            for (const rawUrl of videoUrls) {
                if (!rawUrl || typeof rawUrl !== 'string') continue;
                const unescaped = rawUrl.replace(/&amp;/g, '&').replace(/&#038;/g, '&').replace(/[–—]/g, '--');
                try {
                    const uObj = new URL(unescaped);
                    const key = `${uObj.origin}${uObj.pathname}`.toLowerCase();
                    if (!seenKeys.has(key)) {
                        seenKeys.add(key);
                        cleanVideoUrls.push(unescaped);
                    }
                } catch (e) {
                    if (!cleanVideoUrls.includes(unescaped)) {
                        cleanVideoUrls.push(unescaped);
                    }
                }
            }

            cleanVideoUrls.forEach((videoUrl, index) => {
                const sanitizedTitle = sanitizeFileName(title);
                const fileTitle = cleanVideoUrls.length > 1
                    ? `${sanitizedTitle} ${index + 1}`
                    : sanitizedTitle;
                let command;
                const batchReferer = (lesson.referer || referer || '').replace(/%/g, '%%');
                // Escape % as %% for Windows batch files so cmd.exe doesn't expand them
                const batchUrl = videoUrl.replace(/%/g, '%%');

                if (audioOnly) {
                    // Audio-only commands using yt-dlp to extract and convert directly to MP3
                    const refererFlag = batchReferer.length ? ` --referer "${batchReferer}"` : '';
                    let extraFlags = '';
                    if (videoUrl.includes('vimeo') && !videoUrl.startsWith('https://player')) {
                        extraFlags += ' --cookies-from-browser firefox';
                    }
                    command = `yt-dlp --newline --no-warnings --no-update --progress --console-title -f "ba/b[height<=480]/b" -x --audio-format mp3 --postprocessor-args "ExtractAudio:-stats"${refererFlag}${extraFlags} "${batchUrl}" -o "${fileTitle}.${mediaExt}" -N 4`;
                } else {
                    // Video commands
                    if (videoUrl.includes('youtube')) {
                        command = `yt-dlp --newline --no-warnings --no-update -S ext:mp4 "${batchUrl}" -o "${fileTitle}.mp4" -N 4`;
                    } else if (videoUrl.includes('vimeo.com') || videoUrl.includes('mediadelivery.net/') || videoUrl.startsWith('https://player.hotmart.com/') || videoUrl.includes('.m3u8') || videoUrl.includes('skool.com') || videoUrl.includes('kaltura.com') || videoUrl.includes('learningspace.app') || videoUrl.includes('loom.com')) {
                        if (batchReferer.length) {
                            command = `yt-dlp --newline --no-warnings --no-update --referer "${batchReferer}" "${batchUrl}" -o "${fileTitle}.mp4" -N 4`;
                        } else {
                            command = `yt-dlp --newline --no-warnings --no-update "${batchUrl}" -o "${fileTitle}.mp4" -N 4`;
                        }
                        if (videoUrl.includes('vimeo') && !videoUrl.startsWith('https://player')) {
                            command += ' --cookies-from-browser firefox';
                        }
                    } else {
                        // Handle direct URLs with curl (videos and audios)
                        const isAudioUrl = /\.(mp3|m4a|wav|aac|ogg)(?:[?#]|$)/i.test(videoUrl);
                        let fileExt = 'mp4';
                        if (isAudioUrl) {
                            fileExt = videoUrl.match(/\.(mp3|m4a|wav|aac|ogg)/i)?.[1]?.toLowerCase() || 'mp3';
                        }
                        command = `curl -f -L "${batchUrl}" -o "${fileTitle}.${fileExt}"`;
                        if (batchReferer.length) {
                            command += ' --referer ' + batchReferer;
                        }
                    }
                }
                const targetExt = audioOnly ? mediaExt : (videoUrl.match(/\.(mp3|m4a|wav|aac|ogg)(?:[?#]|$)/i)?.[1]?.toLowerCase() || 'mp4');
                mediaCommands.push(`echo [backup-item] ${fileTitle}.${targetExt}`);
                mediaCommands.push(command);
            });
        }
    };

    for (const [courseName, modulesOrLessons] of Object.entries(jsonData)) {
        for (const [moduleName, lessons] of Object.entries(modulesOrLessons)) {
            for (const lesson of lessons) {
                await processLesson(lesson);
            }
        }
    }

    const shOutputFile = outputFile.replace(/\.bat$/, '.sh');

    // Count actual media download commands
    const dlCommandsCount = mediaCommands.filter(c => /^\s*(curl|yt-dlp)\b/i.test(c)).length;

    if (dlCommandsCount === 0) {
        // No video or audio downloads required for this course!
        // Clean up any stale empty batch/sh file if it was previously created
        if (fs.existsSync(outputFile)) {
            try { fs.unlinkSync(outputFile); } catch (e) { }
        }
        if (fs.existsSync(shOutputFile)) {
            try { fs.unlinkSync(shOutputFile); } catch (e) { }
        }
        return { batPath: null, totalCommands: 0, videoCount: 0 };
    }

    const batchCommands = [
        "chcp 65001>nul",
        '@cd /d "%~dp0"',
        ...mediaCommands
    ];

    // Write batch file (.bat) and shell script (.sh)
    try {
        fs.writeFileSync(outputFile, batchCommands.join('\r\n'), 'utf8');
        console.log(`Batch file created: ${outputFile} (${dlCommandsCount} video downloads)`);

        // Also generate .sh script for Linux / macOS
        const shOutputFile = outputFile.replace(/\.bat$/, '.sh');
        const shCommands = ['#!/usr/bin/env bash', 'set -e', 'cd "$(dirname "$0")"'];
        for (const cmd of batchCommands) {
            if (cmd.startsWith('chcp') || cmd.startsWith('mkdir') || cmd.startsWith('@cd')) continue;
            shCommands.push(cmd);
        }
        fs.writeFileSync(shOutputFile, shCommands.join('\n'), 'utf8');
        try { fs.chmodSync(shOutputFile, '755'); } catch (e) { }
    } catch (error) {
        console.error(`Error writing script files: ${error.message}`);
    }

    return { batPath: outputFile, totalCommands: dlCommandsCount, videoCount: dlCommandsCount };
};

// Process all JSON files in a directory
const processDirectory = async (directoryPath, displayName = null, options = {}) => {
    // Normalize options if displayName is passed as options object
    if (typeof displayName === 'object' && displayName !== null) {
        options = displayName;
        displayName = options.displayName || null;
    }

    try {
        const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(directoryPath, entry.name);

            if (entry.isDirectory()) {
                // If it's a directory, process it recursively
                await processDirectory(fullPath, displayName, options);
            } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.json' && !entry.name.includes("_tutorlms_import")) {
                // If it's a JSON file, process it
                await processJsonFile(fullPath, displayName, options);
            }
        }
    } catch (error) {
        console.error(`Error reading directory "${directoryPath}": ${error.message}`);
    }
};

module.exports = {
    processJsonFile,
    processDirectory,
    fetchJsonFromUrl,
    ensureNumberPrefixes,
    hasProperNumberPrefix,
    cleanOldPrefix,
};

// Allow script execution directly
if (require.main === module) {
    const rawArgs = process.argv.slice(2);
    const audioOnly = rawArgs.some(arg => arg === '--audio' || arg === '-a' || arg === '--audio-only');
    const noNumbering = rawArgs.some(arg => arg === '--no-numbering' || arg === '--no-prefix');
    const filteredArgs = rawArgs.filter(arg => !arg.startsWith('--audio') && arg !== '-a' && arg !== '--no-numbering' && arg !== '--no-prefix');

    const inputPath = filteredArgs[0];
    const displayName = filteredArgs[1] || null;

    if (!inputPath) {
        console.error('Error: No input JSON file or directory provided.');
        console.log('Usage: node jsonToBat.js <input.json|directory> [display_name] [--audio] [--no-numbering]');
        process.exit(1);
    }

    fs.stat(inputPath, async (err, stats) => {
        if (err) {
            console.error(`Error accessing path "${inputPath}": ${err.message}`);
            process.exit(1);
        }

        const options = { audioOnly, noNumbering };

        if (stats.isFile()) {
            await processJsonFile(inputPath, displayName, options);
        } else if (stats.isDirectory()) {
            await processDirectory(inputPath, displayName, options);
        } else {
            console.error("Input path must be a file or directory.");
            process.exit(1);
        }
    });
}