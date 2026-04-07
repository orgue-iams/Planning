/** Mise en forme minimale : **gras** + retours à la ligne (affichage HTML sûr). */
export function formatSimpleRichHtml(text) {
    const parts = String(text ?? '').split(/\*\*/);
    const inner = parts
        .map((p, i) => {
            const d = document.createElement('div');
            d.textContent = p;
            const esc = d.innerHTML;
            return i % 2 === 1 ? `<strong>${esc}</strong>` : esc;
        })
        .join('');
    return inner.replace(/\n/g, '<br>');
}
