/**
 * WordPress Generic Authentication Module
 * 
 * Provides unified, resilient login handling for all WordPress-based LMS platforms
 * (Sensei, LearnDash, Tutor LMS, LifterLMS, CourseWare, etc.).
 */

/**
 * Performs login on a WordPress site with automatic fallback across standard and front-end endpoints.
 * 
 * @param {import('puppeteer').Page} page
 * @param {object} credentials
 * @param {string} credentials.username
 * @param {string} credentials.password
 * @param {string} [credentials.url]
 * @param {string} [credentials.baseUrl]
 * @param {object} [options]
 * @param {string} [options.primaryUrl]
 * @param {string[]} [options.fallbacks]
 * @returns {Promise<boolean>}
 */
async function loginWordPress(page, { username, password, url, baseUrl }, options = {}) {
    if (!username || !password) {
        throw new Error('Both username and password are required for WordPress authentication.');
    }

    const currentOrigin = baseUrl || (url ? new URL(url).origin : new URL(page.url()).origin);
    const targetRedirect = url || currentOrigin;

    // Candidate login endpoints in priority order
    const candidateEndpoints = [
        options.primaryUrl || `${currentOrigin}/wp-login.php?redirect_to=${encodeURIComponent(targetRedirect)}`,
        `${currentOrigin}/wp-login.php`,
        ...(options.fallbacks || []),
        `${currentOrigin}/moje-szkolenia/`,
        `${currentOrigin}/my-courses/`,
        `${currentOrigin}/logowanie/`,
        `${currentOrigin}/login/`,
        `${currentOrigin}/moje-konto/`,
        `${currentOrigin}/profil/`
    ];

    const endpointsToTry = Array.from(new Set(candidateEndpoints.filter(Boolean)));
    let formFound = false;
    let lastError = null;

    const userSelector = 'input[name="log"], #user_login, #sensei_user_login, input[name="username"], input[type="email"], input[id*="user_login"]';
    const passSelector = 'input[name="pwd"], #user_pass, #sensei_user_pass, input[name="password"], input[type="password"]';
    const submitSelector = '#wp-submit, input[name="wp-submit"], input[name="login"], button[name="login"], form button[type="submit"], form input[type="submit"]';

    for (const endpoint of endpointsToTry) {
        try {
            console.log(`[WordPress Auth] Checking login form at: ${endpoint}...`);
            const response = await page.goto(endpoint, {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            }).catch(() => null);

            if (response && response.status() >= 400 && response.status() !== 403) {
                continue; // 404 or server error, skip
            }

            // Check if login inputs are present on this page
            const hasInputs = await page.evaluate((uSel, pSel) => {
                const u = document.querySelector(uSel);
                const p = document.querySelector(pSel);
                return !!(u && p);
            }, userSelector, passSelector);

            // Resolve element handles directly to prevent WP auto-focus race conditions
            const userEl = await page.$(userSelector);
            const passEl = await page.$(passSelector);

            if (!userEl || !passEl) {
                continue;
            }

            formFound = true;
            console.log(`[WordPress Auth] Active login form detected at: ${endpoint}`);

            // Fill username
            await userEl.click({ clickCount: 3 });
            await userEl.type(username, { delay: 25 });

            // Fill password
            await passEl.click({ clickCount: 3 });
            await passEl.type(password, { delay: 25 });

            // Check remember me checkbox if present
            try {
                await page.evaluate(() => {
                    const remember = document.querySelector('#rememberme, input[name="rememberme"]');
                    if (remember && !remember.checked) remember.checked = true;
                });
            } catch (e) {}

            console.log('[WordPress Auth] Submitting credentials...');
            const submitBtn = await page.$(submitSelector);

            await Promise.race([
                page.waitForResponse(res => res.request().method() === 'POST', { timeout: 8000 }).catch(() => null),
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null),
                submitBtn ? submitBtn.click() : page.keyboard.press('Enter')
            ]);

            await new Promise(r => setTimeout(r, 1000));
            const currentUrl = page.url();

            // Jedyne co wystarczy sprawdzić: czy po submicie adres nadal zawiera wp-login.php (nie nastąpiło przekierowanie)
            if (currentUrl.includes('wp-login.php')) {
                const errorText = await page.waitForSelector('#login_error, .woocommerce-error, .login-error, .alert-danger', { timeout: 2000 })
                    .then(el => el.evaluate(e => e.innerText.trim()))
                    .catch(() => null);

                throw new Error(errorText ? `WordPress login failed: ${errorText}` : 'WordPress login failed: Invalid username or password (remained on wp-login.php).');
            }

            // Verify login success for custom front-end forms
            const authResult = await page.evaluate(() => {
                // Check error containers
                const errorEl = document.querySelector('#login_error, .woocommerce-error, .sensei-message.error, .login-error, .alert-danger, .has-error');
                if (errorEl) {
                    return { success: false, error: errorEl.innerText.trim() };
                }

                // Check text for error notices if password field is still displayed
                const passField = document.querySelector('input[type="password"]');
                if (passField) {
                    const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
                    if (bodyText.includes('błąd') || bodyText.includes('nieprawidłowe') || bodyText.includes('invalid') || bodyText.includes('incorrect password')) {
                        return { success: false, error: 'Invalid username or password.' };
                    }
                }

                return { success: true };
            });

            // Verify cookies
            const cookies = await page.cookies();
            const hasWpCookie = cookies.some(c => c.name.startsWith('wordpress_logged_in_'));

            if (!authResult.success) {
                throw new Error(`WordPress login failed: ${authResult.error || 'Invalid credentials'}`);
            }

            console.log('[WordPress Auth] Login successful!');
            return true;

        } catch (err) {
            lastError = err;
            if (err.message.includes('Invalid') || err.message.includes('failed:')) {
                throw err; // Bad credentials, abort further endpoint tries
            }
        }
    }

    if (!formFound) {
        throw new Error(`Could not find a valid WordPress login form on ${currentOrigin}. Tried: ${endpointsToTry.join(', ')}`);
    }

    if (lastError) throw lastError;
    return true;
}

module.exports = {
    loginWordPress
};
