#!/usr/bin/env node

const readline = require('readline');
const path = require('path');
const { CourseBackupEngine } = require('../core/engine');
const platforms = require('../platforms');
const { findCookieFile } = require('../core/cookieManager');

function promptUser(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans.trim());
    }));
}

async function main() {
    const rawArgs = process.argv.slice(2);

    if (rawArgs.length === 0 || rawArgs.includes('--help') || rawArgs.includes('-h')) {
        console.log(`
Course Backup CLI - Course Migration Tool for Creators

Usage:
  node src/cli/cli.js <url> [username] [password] [mode] [flags]

Modes:
  json        Extract structure and save as JSON (default)
  all         Extract structure, download media assets and batch files
  files       Extract structure and download materials / files

Flags:
  --cookies=<path>       Path to session cookies JSON file
  --output-dir=<path>    Custom output destination folder
  --course=<ids>         Preselect course ID(s) (e.g. 1 or 1,2 or 0 for all)
  --audio-only           Extract/generate audio-only download tasks
  --headful              Run browser in visible UI mode (useful for manual captcha)
  --help, -h             Show this help screen
`);
        process.exit(0);
    }

    const positionalArgs = [];
    const flags = {};

    for (const arg of rawArgs) {
        if (arg.startsWith('--')) {
            const [key, val] = arg.slice(2).split('=');
            flags[key] = val !== undefined ? val : true;
        } else {
            positionalArgs.push(arg);
        }
    }

    const url = positionalArgs[0];
    const username = positionalArgs[1] || '';
    const password = positionalArgs[2] || '';
    const mode = positionalArgs[3] || 'json';

    const matched = platforms.match(url);
    const isCookiesOnly = matched && (
        (matched.authMethods && matched.authMethods.length === 1 && matched.authMethods[0] === 'cookies') ||
        matched.id === 'skool'
    );

    if (isCookiesOnly && (username || password)) {
        console.warn(`\n[INFO] Target platform (${matched.name}) uses session cookies. Username and password will be ignored.`);
    } else if (!isCookiesOnly && ((username && !password) || (!username && password))) {
        console.error('\n[ERROR] Both username and password must be provided for authentication (or omit both to rely on session cookies).\n');
        process.exit(1);
    }

    const cookiesPath = flags.cookies || findCookieFile(url, matched?.id) || null;
    const outputDir = flags['output-dir'] ? path.resolve(flags['output-dir']) : path.resolve(process.cwd(), 'output');
    const crss = flags.course || null;
    const isAudioOnly = !!flags['audio-only'];
    const headless = (flags.headful || flags['no-headless']) ? false : true;

    console.log(`\nStarting Course Backup CLI`);
    console.log(`Target: ${url}`);
    if (cookiesPath) {
        console.log(`Session Cookies: ${cookiesPath}`);
    }
    console.log(`Mode: ${mode} | Output: ${outputDir}\n`);

    const engine = new CourseBackupEngine({
        url,
        username,
        password,
        mode,
        outputDir,
        cookiesPath,
        crss,
        isAudioOnly,
        headless
    });

    engine.on('log', ({ message, type }) => {
        if (type === 'error') {
            console.error(`[ERROR] ${message}`);
        } else if (type === 'warning') {
            console.warn(`[WARN]  ${message}`);
        } else if (type === 'success') {
            console.log(`[OK]    ${message}`);
        } else {
            console.log(message);
        }
    });

    engine.on('status', ({ state, text }) => {
        // Can be used for status bar
    });

    engine.on('courses', async (courses) => {
        console.log('\nAvailable courses:');
        console.log('0 - All Courses');
        courses.forEach(c => {
            console.log(`${c.id} - ${c.name} (${c.url})`);
        });

        const choice = await promptUser('\nEnter course ID to export (0 for all, comma-separated for multiple): ');
        engine.selectCourses(choice || '0');
    });

    engine.on('completed', ({ outputDir, courses }) => {
        console.log(`\n========================================`);
        console.log(`Migration export completed successfully!`);
        console.log(`Export directory: ${outputDir}`);
        console.log(`Courses exported: ${courses ? courses.length : 0}`);
        console.log(`========================================\n`);
        process.exit(0);
    });

    engine.on('error', (err) => {
        console.error(`\nMigration failed: ${err.message}`);
        process.exit(1);
    });

    process.on('SIGINT', async () => {
        console.log('\nInterrupt signal received. Cancelling...');
        await engine.cancel();
        process.exit(0);
    });

    await engine.start();
}

main().catch(err => {
    console.error('Fatal CLI Error:', err.message);
    process.exit(1);
});
