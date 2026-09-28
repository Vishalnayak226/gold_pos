// Plain script (not type="module"), registered directly from customer.html.
// Runs after window 'load' so it can never delay or interfere with
// customer-app.js's module bootstrap.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // Scope pinned narrower than the worker's default max-scope ('/', its
        // own directory) so it can never intercept navigations to the admin
        // desk at '/' or '/index.html'. Scope matching is a URL-path PREFIX
        // match, not path-segment — safe today since no route on this server
        // starts with '/customer.html' besides itself.
        navigator.serviceWorker.register('/service-worker.js', { scope: '/customer.html' })
            .catch(() => {});
    });
}
