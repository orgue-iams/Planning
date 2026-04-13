import { isBackendAuthConfigured } from './supabase-client.js';
import { fetchActiveLoginMessage } from '../utils/org-content.js';
import { formatSimpleRichHtml } from '../utils/rich-text.js';

export async function applyLoginBanner() {
    const box = document.getElementById('login-banner-box');
    if (!box) return;

    if (!isBackendAuthConfigured()) {
        box.classList.remove('hidden');
        box.innerHTML = `<p class="text-[10px] text-amber-900 leading-relaxed"><strong>Configuration requise.</strong> Ouvrez <span class="font-mono">js/config/planning.config.js</span> et renseignez <span class="font-mono">supabaseUrl</span> et <span class="font-mono">supabaseAnonKey</span> (projet Supabase).</p>`;
        return;
    }

    const m = await fetchActiveLoginMessage();
    if (!m?.body) {
        box.classList.remove('hidden');
        box.innerHTML = `<p class="text-[10px] text-slate-600 leading-relaxed">Après <span class="font-mono">seed-users.sql</span> : <span class="font-mono">admin@iams.fr</span> → <span class="font-mono">admin1234</span>, <span class="font-mono">prof@iams.fr</span> → <span class="font-mono">prof1234</span>, <span class="font-mono">eleve1@iams.fr</span> → <span class="font-mono">eleve1234</span>, <span class="font-mono">eleve2@iams.fr</span> → <span class="font-mono">eleve2234</span>.</p>`;
        return;
    }
    box.classList.remove('hidden');
    box.innerHTML = `<div class="organ-rich">${formatSimpleRichHtml(m.body)}</div>`;
}
