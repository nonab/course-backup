const fs = require('fs');
const path = require('path');

async function login(page, { username, password }) {
    console.log('Login logic skipped for Skool (cookies should be loaded).');
    // Optional: Check if logged in
    const loggedIn = await page.evaluate(() => {
        return !!document.querySelector('div[data-sentry-component="UserAvatar"], img[alt="User Avatar"]') || !document.querySelector('a[href="/login"]');
    });
    if (!loggedIn) {
        console.warn('Warning: Not detected as logged in. Cookies might be invalid or expired.');
    } else {
        console.log('Login verification successful.');
    }
}

async function getCourses(page, baseUrl, platformUrl) {
    await page.goto(platformUrl, { waitUntil: 'networkidle2' });
    let classroomUrl = page.url();
    if (!classroomUrl.includes('/classroom')) {
        classroomUrl = classroomUrl.replace(/\/$/, '') + '/classroom';
        await page.goto(classroomUrl, { waitUntil: 'networkidle2' });
    }

    const data = await page.evaluate(() => {
        const el = document.querySelector('#__NEXT_DATA__');
        return el ? JSON.parse(el.textContent) : null;
    });

    const pageProps = data?.props?.pageProps;
    const allCourses = pageProps?.allCourses || [];

    const result = [];
    const baseClassroomUrl = classroomUrl.split('/classroom')[0] + '/classroom';

    for (const course of allCourses) {
        if (course.metadata?.hasAccess === 1) {
            result.push({
                name: course.metadata?.title || course.name,
                url: `${baseClassroomUrl}/${course.name}`
            });
        }
    }

    if (result.length === 0) {
        const name = await page.evaluate(() => {
            const titleEl = document.querySelector('h1, .styled__Header-sc-1brgbbt-2');
            return titleEl ? titleEl.textContent.trim() : document.title.replace('Classroom ·', '');
        });
        return [{ name: name || 'Skool Classroom', url: baseClassroomUrl }];
    }

    return result;
}

function renderMarks(text, marks) {
    if (!marks || !marks.length) return text;
    let result = text;
    for (const mark of marks) {
        if (mark.type === 'bold') result = `<strong>${result}</strong>`;
        else if (mark.type === 'italic') result = `<em>${result}</em>`;
        else if (mark.type === 'strike') result = `<s>${result}</s>`;
        else if (mark.type === 'underline') result = `<u>${result}</u>`;
        else if (mark.type === 'code') result = `<code>${result}</code>`;
        else if (mark.type === 'link' && mark.attrs?.href) {
            const href = mark.attrs.href;
            const target = mark.attrs.target || '_blank';
            result = `<a href="${href}" target="${target}" rel="noopener noreferrer">${result}</a>`;
        }
    }
    return result;
}

function renderNode(node) {
    if (!node) return '';
    if (node.type === 'text') {
        return renderMarks(node.text || '', node.marks);
    }
    if (node.type === 'hardBreak') return '<br>';
    if (node.type === 'horizontalRule') return '<hr>';

    const childrenHtml = Array.isArray(node.content) ? node.content.map(renderNode).join('') : '';

    if (node.type === 'paragraph') return `<p>${childrenHtml}</p>`;
    if (node.type === 'heading') {
        const level = node.attrs?.level || 2;
        return `<h${level}>${childrenHtml}</h${level}>`;
    }
    if (node.type === 'bulletList') return `<ul>${childrenHtml}</ul>`;
    if (node.type === 'orderedList') return `<ol>${childrenHtml}</ol>`;
    if (node.type === 'listItem') return `<li>${childrenHtml}</li>`;
    if (node.type === 'blockquote') return `<blockquote>${childrenHtml}</blockquote>`;
    if (node.type === 'codeBlock') return `<pre><code>${childrenHtml}</code></pre>`;

    return childrenHtml;
}

function parseSkoolDesc(desc) {
    if (!desc || typeof desc !== 'string') return null;

    if (!desc.startsWith('[v2]')) {
        return desc;
    }

    let blocks;
    try {
        blocks = JSON.parse(desc.replace(/^\[v2\]/, ''));
    } catch (e) {
        console.warn('Failed to parse Skool desc JSON');
        return null;
    }

    if (!Array.isArray(blocks)) return null;

    const html = blocks.map(renderNode).join('').trim();
    return html || null;
}

async function getStructure(page, courseUrl) {
    await page.goto(courseUrl, { waitUntil: 'networkidle2' });

    const data = await page.evaluate(() => {
        const el = document.querySelector('#__NEXT_DATA__');
        return el ? JSON.parse(el.textContent) : null;
    });

    if (!data) { throw new Error('No __NEXT_DATA__ found'); }
    const pageProps = data.props?.pageProps;
    if (!pageProps) { throw new Error('Invalid NEXT_DATA structure'); }

    try {
        // fs.writeFileSync(path.resolve(__dirname, '../pageProps_debug.json'), JSON.stringify(pageProps, null, 2));
        // console.log(`[DEBUG] Dumped pageProps to ${path.resolve(__dirname, '../pageProps_debug.json')}`);
    } catch (e) { }

    // Check if courseUrl specifies a single course module ID
    const urlParts = courseUrl.split('/classroom/');
    const targetModuleId = urlParts.length > 1 ? urlParts[1].split('/')[0].split('?')[0] : null;

    const classroomTitle = pageProps.settings?.pageMeta?.title?.replace(/^Classroom · /, '')?.trim() || 'Course';
    const structuredData = {};

    let allCourses = pageProps.allCourses || [];
    if (!allCourses.length && pageProps.course) {
        allCourses = [pageProps.course];
    }
    if (targetModuleId && allCourses.length > 1) {
        const filtered = allCourses.filter(c => c.name === targetModuleId || c.id === targetModuleId);
        if (filtered.length > 0) {
            allCourses = filtered;
        }
    }

    const buildId = data.buildId;
    const groupName = pageProps.group?.name || courseUrl.split('/').filter(Boolean).slice(-2, -1)[0] || 'grocycle';
    const baseClassroomUrl = courseUrl.split('/classroom')[0] + '/classroom';

    for (const moduleObj of allCourses) {
        const targetCourseObj = moduleObj.course || moduleObj;
        if (targetCourseObj.metadata?.hasAccess === 0) {
            console.log(`Skipping module "${targetCourseObj.metadata?.title || 'Unknown'}" due to lack of access.`);
            continue; // Go to the next module in the loop
        }

        const rawModuleId = targetCourseObj.name || targetModuleId || targetCourseObj.id || pageProps.course?.course?.name || pageProps.course?.name || pageProps.course?.id;
        const cleanModuleId = (rawModuleId && rawModuleId !== 'undefined') ? rawModuleId : (courseUrl.split('/classroom/')[1]?.split('/')[0]?.split('?')[0] || '');
        const courseTitle = targetCourseObj.metadata?.title || pageProps.course?.course?.metadata?.title || pageProps.course?.metadata?.title || 'Course';

        let moduleData = null;
        if (buildId && cleanModuleId) {
            const nextJsonUrl = `https://www.skool.com/_next/data/${buildId}/english/${groupName}/classroom/${cleanModuleId}.json?group=${groupName}&course=${cleanModuleId}`;
            moduleData = await page.evaluate(async (apiUrl) => {
                try {
                    const res = await fetch(apiUrl, { credentials: 'include' });
                    if (res.ok) return await res.json();
                } catch (e) { }
                return null;
            }, nextJsonUrl);
        }

        let children = moduleData?.pageProps?.course?.course?.children || moduleData?.pageProps?.course?.children || targetCourseObj.children || pageProps.course?.course?.children || pageProps.course?.children || [];
        if (!children.length && cleanModuleId) {
            const moduleUrl = `${baseClassroomUrl}/${cleanModuleId}`;
            await page.goto(moduleUrl, { waitUntil: 'networkidle2' });

            const loadedData = await page.evaluate(() => {
                const el = document.querySelector('#__NEXT_DATA__');
                return el ? JSON.parse(el.textContent) : null;
            });
            children = loadedData?.props?.pageProps?.course?.course?.children || loadedData?.props?.pageProps?.course?.children || [];
        }

        const hasSets = children.some(c => (c.course?.unitType || c.unitType) === 'set');
        const setGroupMap = new Map();

        if (hasSets) {
            for (const child of children) {
                const childObj = child.course || child;
                if (childObj.unitType === 'set') {
                    const rawSetTitle = childObj.metadata?.title || '';
                    const setTitle = (rawSetTitle && rawSetTitle !== 'Course Contents') ? rawSetTitle : 'Course Contents';
                    const setLessons = child.children || [];
                    if (!setGroupMap.has(setTitle)) setGroupMap.set(setTitle, []);
                    setGroupMap.get(setTitle).push(...setLessons);
                } else {
                    if (!setGroupMap.has('Course Contents')) setGroupMap.set('Course Contents', []);
                    setGroupMap.get('Course Contents').push(child);
                }
            }
        } else {
            setGroupMap.set('Course Contents', children);
        }

        if (!structuredData[courseTitle]) {
            structuredData[courseTitle] = {};
        }

        for (const [subTitle, lessons] of setGroupMap.entries()) {
            if (!structuredData[courseTitle][subTitle]) {
                structuredData[courseTitle][subTitle] = [];
            }

            for (const child of lessons) {
                const lessonCourse = child.course || child;
                if (!lessonCourse) continue;

                const lessonId = lessonCourse.id;
                const lessonTitleRaw = lessonCourse.metadata?.title || 'Lesson';

                // Navigate to individual lesson URL to load complete metadata (video + resources)
                const lessonUrl = `${baseClassroomUrl}/${cleanModuleId}?md=${lessonId}`;
                console.log(`\n[DEBUG] Processing Lesson "${lessonTitleRaw}" (ID: ${lessonId})`);
                console.log(`[DEBUG] Navigating to lesson URL: ${lessonUrl}`);
                await page.goto(lessonUrl, { waitUntil: 'domcontentloaded' });

                const lessonData = await page.evaluate(() => {
                    const el = document.querySelector('#__NEXT_DATA__');
                    return el ? JSON.parse(el.textContent) : null;
                });

                const courseWrapper = lessonData?.props?.pageProps?.course;
                const childrenList = courseWrapper?.children || (Array.isArray(courseWrapper) ? courseWrapper : []);
                const foundLessonObj = childrenList.find(c => (c.course?.id || c.id) === lessonId);
                const lessonMeta = foundLessonObj?.course?.metadata || foundLessonObj?.metadata || lessonCourse.metadata;

                console.log(`[DEBUG] lessonMeta found? ${!!lessonMeta}`);
                if (lessonMeta) {
                    console.log(`[DEBUG] videoId: ${lessonMeta.videoId}, video_id: ${lessonMeta.video_id}, videoLink: ${lessonMeta.videoLink}`);
                    console.log(`[DEBUG] raw video property:`, lessonMeta.video);
                }

                const videoUrls = [];
                if (lessonMeta?.videoLink) {
                    videoUrls.push(lessonMeta.videoLink);
                }

                const pagePropsVideo = lessonData?.props?.pageProps?.video;
                if (pagePropsVideo?.playbackId && pagePropsVideo?.playbackToken) {
                    const directStreamUrl = `https://stream.video.skool.com/${pagePropsVideo.playbackId}.m3u8?token=${pagePropsVideo.playbackToken}`;
                    videoUrls.push(directStreamUrl);
                    console.log(`  -> Found video stream URL directly from pageProps.video`);
                } else {
                    let playbackId = null;
                    if (lessonMeta?.video) {
                        try {
                            const vData = typeof lessonMeta.video === 'string' ? JSON.parse(lessonMeta.video) : lessonMeta.video;
                            playbackId = vData?.playback_id || vData?.playbackId;
                        } catch (e) { }
                    }
                    if (!playbackId) {
                        playbackId = lessonMeta?.videoId || lessonMeta?.video_id;
                    }

                    if (playbackId) {
                        const streamApiUrl = `https://api2.skool.com/videos/${playbackId}/stream-url`;
                        const streamUrl = await page.evaluate(async (url) => {
                            try {
                                const res = await fetch(url, { method: 'POST', credentials: 'include' });
                                if (res.ok) {
                                    const json = await res.json();
                                    return json.url || null;
                                }
                            } catch (e) { }
                            return null;
                        }, streamApiUrl);

                        if (streamUrl) {
                            videoUrls.push(streamUrl);
                            console.log(`  -> Found video stream URL via API`);
                        }
                    }
                }

                const domHtml = await page.evaluate(() => {
                    const el = document.querySelector('.tiptap.ProseMirror, .skool-editor2');
                    return el ? el.innerHTML.trim() : null;
                });
                const descRaw = lessonMeta?.desc || null;
                let html = (domHtml && domHtml.length > 0) ? domHtml : parseSkoolDesc(descRaw);

                const downloads = [];
                if (lessonMeta?.resources && lessonMeta.resources.length) {
                    const linkResourcesHtml = [];
                    try {
                        const resources = typeof lessonMeta.resources === 'string' ? JSON.parse(lessonMeta.resources) : lessonMeta.resources;
                        for (const resource of resources) {
                            if (resource.file_id) {
                                const apiUrl = `https://api2.skool.com/files/${resource.file_id}/download-url?expire=28800`;
                                const apiResponse = await page.evaluate(async (url) => {
                                    try {
                                        const response = await fetch(url, { method: 'POST', credentials: 'include' });
                                        return {
                                            status: response.status,
                                            statusText: response.statusText,
                                            body: await response.text(),
                                            ok: response.ok
                                        };
                                    } catch (e) {
                                        return { error: e.message };
                                    }
                                }, apiUrl);

                                if (apiResponse.ok && apiResponse.body && apiResponse.body.startsWith('http')) {
                                    downloads.push({
                                        href: apiResponse.body,
                                        text: resource.file_name.normalize('NFC'),
                                    });
                                    console.log(`  -> Found attached resource: ${resource.file_name}`);
                                }
                            } else if (resource.link) {
                                console.log(`  -> Found external link: ${resource.title}`);
                                const title = (resource.title || 'External Link').normalize('NFC');
                                linkResourcesHtml.push(`<li><a href="${resource.link}" target="_blank" rel="noopener noreferrer">${title}</a></li>`);
                            }
                        }
                    } catch (e) {
                        console.error('Failed to parse resources:', e.message);
                    }

                    if (linkResourcesHtml.length > 0) {
                        const linksHtmlBlock = `
                            <hr>
                            <h2>Attached Links</h2>
                            <ul>
                                ${linkResourcesHtml.join('')}
                            </ul>
                        `;
                        html = (html || '') + linksHtmlBlock;
                    }
                }

                structuredData[courseTitle][subTitle].push({
                    title: lessonTitleRaw,
                    "video url(s)": videoUrls,
                    html: html,
                    referer: 'https://www.skool.com/',
                    cookies: {},
                    downloads: downloads,
                });

                console.log(`Processing: ${lessonTitleRaw}`);
            }
        }
    }

    return structuredData;
}


async function scrapLessonData(page, structure, savePath) {

    return structure;
}

module.exports = {
    id: 'skool',
    name: 'Skool',
    domains: ["skool.com"],
    detectionKeywords: ["skool.com"],
    authMethods: ["cookies"],
    login,
    getCourses,
    getStructure,
    scrapLessonData
};
