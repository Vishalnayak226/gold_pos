/**
 * ==========================================================================
 * QR Code Canvas Renderer
 * Fetches a real, scannable QR code from the backend (/api/qrcode, backed by
 * the `qrcode` npm package server-side) and draws it onto a canvas. Frontend
 * stays buildless/dependency-free; the encoding itself happens server-side.
 * ==========================================================================
 */
export async function drawQR(canvas, text) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    try {
        const res = await fetch(`/api/qrcode?data=${encodeURIComponent(text)}`);
        if (!res.ok) throw new Error('QR generation request failed');
        const { dataUrl } = await res.json();

        const img = new Image();
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = dataUrl;
        });

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
    } catch (err) {
        console.error('QR generation failed:', err);
        drawFallbackMessage(ctx, width, height, 'QR unavailable — check your connection');
    }
}

function drawFallbackMessage(ctx, width, height, message) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#ef4444';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(message, width / 2, height / 2, width - 20);
}
