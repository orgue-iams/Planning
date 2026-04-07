import { isBackendAuthConfigured } from './supabase-client.js';
import { fetchActiveLoginMessage } from '../utils/org-content.js';
import { formatSimpleRichHtml } from '../utils/rich-text.js';

export async function applyLoginBanner() {
    const box = document.getElementById('login-banner-box');
    const demo = document.getElementById('login-demo-hint');
    if (!box) return;

    if (!isBackendAuthConfigured()) {
        box.classList.add('hidden');
        box.innerHTML = '';
        demo?.classList.remove('hidden');
        return;
    }

    demo?.classList.add('hidden');
    const m = await fetchActiveLoginMessage();
    if (!m?.body) {
        box.classList.add('hidden');
        box.innerHTML = '';
        return;
    }
    box.classList.remove('hidden');
    box.innerHTML = `<div class="organ-rich">${formatSimpleRichHtml(m.body)}</div>`;
}
