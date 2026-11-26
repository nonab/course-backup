const fs = require('fs');
const cheerio = require('cheerio');
const axios = require('axios');
async function login(page, { username, password }) {

}

async function getCourses(page, baseUrl) {
    await page.goto(baseUrl + "/school", { waitUntil: 'networkidle0' });
    console.log("Retrieving courses list...");//https://members.dotcomtruths.com/api/membership/enrollments/list?pagination[limit]=12
    const apiUrl = baseUrl + "/api/membership/enrollments/list";
    console.log(apiUrl);
    const cookies = await page.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const response = await page.evaluate(async (apiUrl, cookieHeader, baseUrl) => {
        try {
            const res = await fetch(apiUrl, {
                method: 'GET',
                headers: {
                    'Cookie': cookieHeader,
                    'Accept': 'application/json',
                    'x-requested-with': 'XMLHttpRequest',
                    'Referer': baseUrl + '/school'
                }
            });

            const text = await res.text(); // nie od razu .json, żeby sprawdzić co wraca
            return {
                ok: res.ok,
                status: res.status,
                statusText: res.statusText,
                body: text
            };
        } catch (err) {
            return { error: err.toString() };
        }
    }, apiUrl, cookieHeader, baseUrl);

    // Debug log
    if (response.error) {
        throw new Error("Request threw an exception: " + response.error);
    }
    if (!response.ok) {
        throw new Error(`Failed to fetch course data: ${response.status} ${response.statusText}\nBody:\n${response.body}`);
    }

    let data;
    try {
        data = JSON.parse(response.body);
    } catch (err) {
        throw new Error("Failed to parse response JSON: " + err.message + "\nBody:\n" + response.body);
    }

    if (!data.items) {
        console.log(data);
        throw new Error('Missing expected `items` field in response.');
    }

    let courses = [];
    for (const item of data.items) {
        if (item.type === 'course' && item.data) {
            const course = item.data;

            courses.push({
                id: item.id,
                name: course.name,
                url: course.resumeUrl
            });
        }
    }

    // Sort courses by name
    courses.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    return courses;
}

async function fetchJsonWithCookies(page, apiUrl, refererUrl) {
    const baseUrl = new URL(refererUrl).origin;

    const cookies = await page.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const response = await page.evaluate(async (apiUrl, cookieHeader, refererUrl, baseUrl) => {
        try {
            const res = await fetch(apiUrl, {
                method: 'GET',
                headers: {
                    'Cookie': cookieHeader,
                    'Accept': 'application/json',
                    'x-requested-with': 'XMLHttpRequest',
                    'Referer': refererUrl
                }
            });

            const text = await res.text();
            return {
                ok: res.ok,
                status: res.status,
                statusText: res.statusText,
                body: text
            };
        } catch (err) {
            return { error: err.toString() };
        }
    }, apiUrl, cookieHeader, refererUrl);

    if (response.error) {
        throw new Error("Fetch error: " + response.error);
    }

    let data;
    try {
        data = JSON.parse(response.body);
    } catch (err) {
        throw new Error("Failed to parse JSON: " + err.message + "\nBody:\n" + response.body);
    }

    return data;
}


async function getStructure(page, courseUrl) {
    // Extract slug from courseUrl
    await page.goto(courseUrl, { waitUntil: 'networkidle2' });

    const baseUrl = courseUrl.split('/school')[0];
    const slug = courseUrl.split('/course/')[1];
    let apiUrl = baseUrl + '/api/membership/course/' + slug;

    const courseData = await fetchJsonWithCookies(page, apiUrl, courseUrl);

    if (!courseData.id) {
        console.log(courseData);
        throw new Error('Missing expected `id` field in response.');
    }

    const courseId = courseData.id;
    const courseTitle = courseData.name;
    apiUrl = baseUrl + '/api/membership/course/' + courseId + '/menu'
    const lessonData = await fetchJsonWithCookies(page, apiUrl, courseUrl);
    const structuredData = { [courseTitle]: {} };
    structuredData[courseTitle][courseTitle] = [];
    let lessonIndex = 1;

    for (const section of lessonData) {
        for (const lecture of section.lectures) {
            const lectureId = lecture.id;
            const lectureName = lecture.name;
            const lectureUrl = `${baseUrl}/api/membership/lecture/${lectureId}`;

            try {
                let lectureData = await fetchJsonWithCookies(page, lectureUrl, courseUrl);
                lectureData.title = `${String(lessonIndex).padStart(2, '0')} - ${lectureName}`;
                lectureData['video url(s)'] = [];

                const decodedHtml = JSON.parse(`"${lectureData.html.replace(/"/g, '\\"')}"`);
                const $ = cheerio.load(decodedHtml);

                // === VOOMLY ===
                const voomlyElement = $('[class="voomly-embed"]');
                const voomlyId = voomlyElement.attr('data-id');
                if (voomlyId) {
                    const voomlyUrl = `https://api.voomly.com/embed-videos/${voomlyId}`;
                    try {
                        const voomlyResponse = await axios.get(voomlyUrl);
                        const qualities = voomlyResponse.data?.video?.qualityOptions || [];
                        if (qualities.length) {
                            const bestQuality = qualities.reduce((prev, curr) =>
                                curr.height > prev.height ? curr : prev
                            );
                            lectureData['video url(s)'].push(bestQuality.hlsUrl);
                        }
                    } catch (e) {
                        console.warn(`Voomly fetch failed for ${lectureData.title}:`, e.message);
                    }
                }

                // === WISTIA ===
                const wistiaMatch = html.match(/https:\/\/fast\.wistia\.com\/embed\/medias\/[a-zA-Z0-9]+/g);
                if (wistiaMatch) {
                    lectureData['video url(s)'].push(...wistiaMatch);
                }

                // === YOUTUBE ===
                const youtubeMatch = html.match(/https:\/\/www\.youtube\.com\/embed\/[a-zA-Z0-9_-]+/g);
                if (youtubeMatch) {
                    lectureData['video url(s)'].push(...youtubeMatch);
                }


                structuredData[courseTitle][courseTitle].push(lectureData);
                console.log(`Fetched lecture ${lectureId}: ${lectureData.title}`);
                lessonIndex++;
            } catch (err) {
                console.error(`Failed to fetch lecture ${lectureId}:`, err.message);
            }
        }
    }
    return structuredData;
}




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


async function scrapLessonData(page, structure) {
    return structure;
}


module.exports = {
    id: 'systeme',
    name: 'Systeme.io',
    domains: ["systeme.io", "members.dotcomtruths.com"],
    detectionKeywords: ["systeme.io"],
    authMethods: ["cookies"],
    login,
    getCourses,
    getStructure,
    scrapLessonData
};
