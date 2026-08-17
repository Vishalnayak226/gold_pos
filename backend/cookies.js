/**
 * ==========================================================================
 * Minimal Cookie header parsing/serialisation.
 *
 * No new dependency for this — parsing `Cookie:` and building `Set-Cookie:`
 * is a handful of lines, and the dependency budget in CLAUDE.md §0 is a
 * deliberate, announced decision, not something a cookie parser earns.
 * ==========================================================================
 */

/** Parses a request's `Cookie` header into a plain name -> value object. */
export function parseCookies(header) {
    const out = {};
    if (!header) return out;
    String(header).split(';').forEach(part => {
        const idx = part.indexOf('=');
        if (idx === -1) return;
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (!name) return;
        try {
            out[name] = decodeURIComponent(value);
        } catch {
            out[name] = value;
        }
    });
    return out;
}

/**
 * Builds one `Set-Cookie` header value.
 *
 * `httpOnly` defaults false because the two cookie kinds in this app are
 * genuinely different: a session cookie must never be readable by JS, a CSRF
 * cookie must always be — so the caller states it explicitly rather than
 * relying on a default either way could silently get wrong.
 */
export function serializeCookie(name, value, { maxAgeMs, path = '/', httpOnly = false, sameSite = 'Lax', secure = false } = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
    if (maxAgeMs !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`);
    if (httpOnly) parts.push('HttpOnly');
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

/** A Set-Cookie value that expires the cookie immediately (logout). */
export function clearCookie(name, opts = {}) {
    return serializeCookie(name, '', { ...opts, maxAgeMs: 0 });
}
