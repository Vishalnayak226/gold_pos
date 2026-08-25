// Custom UI Alert Override
//
// Built with DOM nodes, not innerHTML: `message` can carry a server-supplied
// string (an operator name, an error detail, a customer name from a lookup),
// and this override is the one place every admin-desk message funnels
// through. textContent makes that structurally un-injectable — the same
// pattern customer.html already used here; this file brings index.html to
// the same standard (security audit C4).
//
// A plain non-module script, loaded synchronously in <head> exactly where
// the inline version used to sit, so window.alert is overridden before
// anything else on the page can call it.
window.alert = function (message) {
    if (document.getElementById('custom-alert-box')) return;

    const isSuccess = String(message).toLowerCase().includes('success');
    const icon = isSuccess ? '✓' : '!';
    const iconBg = isSuccess ? '#dcfce7' : '#f1f5f9';
    const iconColor = isSuccess ? '#166534' : '#334155';

    const overlay = document.createElement('div');
    overlay.id = 'custom-alert-box';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(15,23,42,0.8);display:flex;align-items:center;justify-content:center;z-index:999999;backdrop-filter:blur(2px);';

    const card = document.createElement('div');
    card.style.cssText = "background:#ffffff; border-radius:8px; padding:25px; width:90%; max-width:400px; box-shadow:0 10px 25px rgba(0,0,0,0.2); text-align:center; border:1px solid #cbd5e1; font-family:'Outfit',sans-serif;";

    const badge = document.createElement('div');
    badge.style.cssText = `width:40px; height:40px; border-radius:50%; background:${iconBg}; color:${iconColor}; display:flex; align-items:center; justify-content:center; margin:0 auto 15px; font-weight:bold; font-size:20px;`;
    badge.textContent = icon;

    const text = document.createElement('p');
    text.style.cssText = 'color:#1e293b; font-size:14px; line-height:1.5; margin-bottom:20px; font-weight:500;';
    text.textContent = message;

    const okBtn = document.createElement('button');
    okBtn.style.cssText = "background:#0f172a; color:#fff; border:none; padding:10px 25px; border-radius:6px; cursor:pointer; font-weight:600; width:100%; font-family:'Outfit',sans-serif;";
    okBtn.textContent = 'OK';
    okBtn.addEventListener('click', () => overlay.remove());

    card.append(badge, text, okBtn);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
};
