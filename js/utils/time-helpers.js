/**
 * Génère les options des sélecteurs d'heures
 */
export function populateTimeSelects(startId, endId) {
    const startSelect = document.getElementById(startId);
    const endSelect = document.getElementById(endId);
    
    if (!startSelect || !endSelect) return;

    for (let h = 8; h <= 22; h++) {
        ['00', '30'].forEach(m => {
            const time = `${h.toString().padStart(2, '0')}:${m}`;
            startSelect.add(new Option(time, time));
            endSelect.add(new Option(time, time));
        });
    }
    
    // Valeur par défaut pour la fin (souvent +1h)
    endSelect.selectedIndex = 2; 
}
