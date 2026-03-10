// Vercel serverless function: serves share.html with dynamic OG meta tags.
// Social crawlers get the per-scan preview image; browsers get the full viewer.

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://c969ue4f2j.execute-api.us-east-1.amazonaws.com/prod';
const SITE_URL = 'https://facemog.app';

// Cache the template in memory (cold start only reads once)
let templateHtml = null;

function getTemplate() {
    if (!templateHtml) {
        // Try multiple paths — Vercel bundles includeFiles relative to project root
        const candidates = [
            path.join(__dirname, '..', 'share.html'),
            path.join(process.cwd(), 'share.html'),
            path.join(__dirname, 'share.html'),
        ];
        for (const p of candidates) {
            try {
                templateHtml = fs.readFileSync(p, 'utf-8');
                break;
            } catch {}
        }
        if (!templateHtml) {
            console.error('Could not find share.html template');
            templateHtml = '<!DOCTYPE html><html><body>Error loading template</body></html>';
        }
    }
    return templateHtml;
}

module.exports = async (req, res) => {
    const shareId = req.query.id;
    if (!shareId || !/^[a-zA-Z0-9]+$/.test(shareId)) {
        res.status(400).send('Invalid share ID');
        return;
    }

    let previewUrl = '';
    let title = 'Check out my face analysis on FaceMog';
    let description = 'AI-powered 3D face analysis and looksmaxx recommendations';

    // Fetch share data to get the per-scan preview image URL
    try {
        const resp = await fetch(`${API_BASE}/v1/share/${shareId}`);
        if (resp.ok) {
            const data = await resp.json();
            if (data.previewUrl) {
                previewUrl = data.previewUrl;
            }
        }
    } catch (e) {
        // Non-fatal — just serve without preview
        console.error('Failed to fetch share data:', e.message);
    }

    const pageUrl = `${SITE_URL}/s/${shareId}`;

    // Read template and inject dynamic meta tags
    let html = getTemplate();

    // Replace static OG tags with dynamic ones
    html = html.replace(
        /<meta property="og:image"[^>]*>/,
        previewUrl
            ? `<meta property="og:image" content="${escapeAttr(previewUrl)}">`
            : '<!-- no preview image available -->'
    );
    html = html.replace(
        /<meta property="og:url"[^>]*>/,
        `<meta property="og:url" content="${escapeAttr(pageUrl)}">`
    );
    html = html.replace(
        /<meta name="twitter:image"[^>]*>/,
        previewUrl
            ? `<meta name="twitter:image" content="${escapeAttr(previewUrl)}">`
            : '<!-- no preview image available -->'
    );
    html = html.replace(
        /<meta property="og:title"[^>]*>/,
        `<meta property="og:title" content="${escapeAttr(title)}">`
    );
    html = html.replace(
        /<meta name="twitter:title"[^>]*>/,
        `<meta name="twitter:title" content="${escapeAttr(title)}">`
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    res.status(200).send(html);
};

function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
