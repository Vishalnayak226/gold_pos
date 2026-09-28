// Runs synchronously (classic script, blocks HTML parsing) before the app's
// module bundle loads, so a refreshed, still-logged-in session lands on the
// app directly instead of flashing the login screen first. Must be an
// external file, not inline - the CSP's script-src has no 'unsafe-inline'.
if (sessionStorage.getItem('adminAuthenticated') === '1') {
    document.documentElement.classList.add('gp-authenticated');
}
