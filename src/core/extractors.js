/**
 * Shared media and content extraction utilities for platform adapters.
 */

/**
 * Extracts all embedded video URLs from the current page.
 * Detects:
 * - Vimeo (player.vimeo.com, vimeo.com)
 * - YouTube (youtube.com, youtu.be)
 * - Hotmart Player (player.hotmart.com)
 * - Wistia (fast.wistia.net, fast.wistia.com, .wistia_embed containers)
 * - BunnyCDN / MediaDelivery (iframe.mediadelivery.net, bunnycdn.com)
 * - Kaltura (kaltura.com)
 * - Cloudflare Stream (cloudflarestream.com)
 * - Native HTML5 video (<video>, <source src="...">)
 * - Direct HLS (.m3u8) / MP4 streams
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string[]>}
 */
async function extractVideoUrls(page) {
    if (!page) return [];
    try {
        const urls = await page.evaluate(() => {
            const result = new Set();

            // 1. Iframes (Vimeo, YouTube, Hotmart, Wistia, BunnyCDN, Cloudflare, Kaltura)
            const iframes = Array.from(document.querySelectorAll('iframe[src], iframe[data-src]'));
            for (const iframe of iframes) {
                const src = iframe.src || iframe.getAttribute('data-src') || '';
                if (!src) continue;

                if (
                    src.includes('vimeo.com') ||
                    src.includes('youtube.com') ||
                    src.includes('youtu.be') ||
                    src.includes('player.hotmart.com') ||
                    src.includes('wistia.com') ||
                    src.includes('wistia.net') ||
                    src.includes('mediadelivery.net') ||
                    src.includes('bunnycdn') ||
                    src.includes('cloudflarestream.com') ||
                    src.includes('kaltura.com') ||
                    src.includes('loom.com') ||
                    /\.(mp4|m3u8|webm)($|\?)/i.test(src)
                ) {
                    result.add(src);
                }
            }

            // 2. Native HTML5 <video> elements and child <source> tags
            const videos = Array.from(document.querySelectorAll('video'));
            for (const video of videos) {
                if (video.src && !video.src.startsWith('blob:')) {
                    result.add(video.src);
                }
                const sources = Array.from(video.querySelectorAll('source[src]'));
                for (const source of sources) {
                    if (source.src && !source.src.startsWith('blob:')) {
                        result.add(source.src);
                    }
                }
            }

            // 3. Wistia embedded containers (div.wistia_embed, data-wistia-id, wistia_async_*)
            const wistiaEmbeds = Array.from(document.querySelectorAll('.wistia_embed, [data-wistia-id], [class*="wistia_async_"]'));
            for (const el of wistiaEmbeds) {
                let wistiaId = el.getAttribute('data-wistia-id');
                if (!wistiaId) {
                    const match = (el.className || '').match(/wistia_async_([a-zA-Z0-9]+)/);
                    if (match) wistiaId = match[1];
                }
                if (wistiaId) {
                    result.add(`https://fast.wistia.net/embed/iframe/${wistiaId}`);
                }
            }

            // TIER 1: If any video player or stream was found, return immediately
            if (result.size > 0) {
                return Array.from(result);
            }

            // TIER 2: Fallback - Native HTML5 <audio> elements and child <source> tags
            const audios = Array.from(document.querySelectorAll('audio, [class*="audio"] audio'));
            for (const audio of audios) {
                if (audio.src && !audio.src.startsWith('blob:') && !audio.src.startsWith('data:')) {
                    result.add(audio.src);
                }
                const sources = Array.from(audio.querySelectorAll('source[src]'));
                for (const source of sources) {
                    if (source.src && !source.src.startsWith('blob:') && !source.src.startsWith('data:')) {
                        result.add(source.src);
                    }
                }
            }

            if (result.size > 0) {
                return Array.from(result);
            }

            // TIER 3: Fallback - Single audio link in lesson content
            // If there is NO video and NO <audio> tag, but exactly ONE .mp3/.m4a link exists,
            // treat it as the main lesson audio. If multiple exist, leave them for downloads.
            const audioExtRegex = /\.(mp3|m4a|wav)(?:[?#]|$)/i;
            const audioLinks = new Set();
            const links = Array.from(document.querySelectorAll('a[href]'));
            for (const link of links) {
                const href = link.href;
                if (href && audioExtRegex.test(href) && !href.startsWith('javascript:') && !href.endsWith('#')) {
                    audioLinks.add(href);
                }
            }

            if (audioLinks.size === 1) {
                result.add(Array.from(audioLinks)[0]);
            }

            return Array.from(result);
        });

        return Array.isArray(urls) ? urls : [];
    } catch (e) {
        return [];
    }
}

/**
 * Extracts downloadable asset links (PDF, ZIP, DOCX, MP3, etc.)
 *
 * @param {import('puppeteer').Page} page
 * @param {string} [containerSelector]
 * @returns {Promise<Array<{ text: string, href: string }>>}
 */
async function extractDownloadLinks(page, containerSelector = null) {
    if (!page) return [];
    try {
        return await page.evaluate((selector) => {
            const root = selector ? document.querySelector(selector) : document;
            if (!root) return [];

            const links = Array.from(root.querySelectorAll('a[href]'));
            const downloads = [];
            const seen = new Set();

            for (const a of links) {
                const href = a.href;
                if (!href || href.startsWith('javascript:') || href.includes('#') || seen.has(href)) continue;

                const isAsset = /\.(zip|rar|7z|pdf|docx?|xlsx?|pptx?|mp3|wav|epub|mobi|csv|txt)($|\?)/i.test(href);
                const isDownloadLink = a.hasAttribute('download') || (a.className && a.className.includes('download'));

                if (isAsset || isDownloadLink) {
                    seen.add(href);
                    downloads.push({
                        text: a.textContent.trim() || a.getAttribute('download') || 'Material',
                        href: href
                    });
                }
            }
            return downloads;
        }, containerSelector);
    } catch (e) {
        return [];
    }
}

/**
 * Inspects a video URL to identify its hosting provider and determine whether
 * it uses ephemeral / expiring session tokens (requiring inline download).
 *
 * @param {string} url
 * @returns {{ provider: string, hasExpiringToken: boolean }}
 */
function inspectVideoUrl(url) {
    if (!url || typeof url !== 'string') {
        return { provider: 'unknown', hasExpiringToken: false };
    }

    const lower = url.toLowerCase();

    // Hotmart Player (encrypted or session-signed playback tokens with short lifespans)
    if (lower.includes('player.hotmart.com') || lower.includes('hotmart.com/')) {
        return { provider: 'hotmart', hasExpiringToken: true };
    }

    // Skool HLS streams with playbackToken
    if (lower.includes('stream.video.skool.com') || lower.includes('skool.com')) {
        return { provider: 'skool', hasExpiringToken: true };
    }

    // Generic presigned URLs with temporary expiration signatures
    if (/[?&](token|sig|signature|expires|exp|playbacktoken|auth_token)=/i.test(url)) {
        return { provider: 'tokenized_stream', hasExpiringToken: true };
    }

    // Durable providers
    if (lower.includes('wistia.com') || lower.includes('wistia.net')) {
        return { provider: 'wistia', hasExpiringToken: false };
    }
    if (lower.includes('youtube.com') || lower.includes('youtu.be')) {
        return { provider: 'youtube', hasExpiringToken: false };
    }
    if (lower.includes('vimeo.com') || lower.includes('player.vimeo.com')) {
        return { provider: 'vimeo', hasExpiringToken: false };
    }
    if (lower.includes('mediadelivery.net') || lower.includes('bunnycdn')) {
        return { provider: 'bunny', hasExpiringToken: false };
    }
    if (lower.includes('loom.com')) {
        return { provider: 'loom', hasExpiringToken: false };
    }

    return { provider: 'generic', hasExpiringToken: false };
}

module.exports = {
    extractVideoUrls,
    extractDownloadLinks,
    inspectVideoUrl
};
