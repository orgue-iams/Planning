const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbytvTaSR7HjfxB6ntzdiKEShzgxILU5HXraD2YOYVRGoamwovG0Uimt9ldtVhI53PTY/exec";

function login() {
    const email = document.getElementById('userEmail').value;
    if(!email) return;
    localStorage.setItem('orgue_user', email.toLowerCase());
    showApp();
}

function showApp() {
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('appSection').style.display = 'block';
    document.getElementById('navBar').style.display = 'flex';
}

function openModal(id) {
    closeModals();
    document.getElementById(id).style.display = 'block';
}

function closeModals() {
    document.getElementById('modalResa').style.display = 'none';
    document.getElementById('modalListe').style.display = 'none';
}

function sendAction(action, extraData = {}) {
    const email = localStorage.getItem('orgue_user');
    let data = { action: action, email: email, ...extraData };

    if(action === 'reserve') {
        data.start = document.getElementById('eventStart').value;
        data.end = document.getElementById('eventEnd').value;
    }

    fetch(SCRIPT_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify(data) })
    .then(() => {
        alert("Demande enregistrée !");
        closeModals();
        document.getElementById('googleCal').src += ''; // Refresh iframe
    });
}

function showMyEvents() {
    openModal('modalListe');
    const email = localStorage.getItem('orgue_user');
    const listDiv = document.getElementById('mesEventsList');
    listDiv.innerHTML = "Chargement...";

    // Note: Le "no-cors" empêche de lire la réponse JSON directe. 
    // Pour une vraie liste, il faudrait une petite astuce de fetch.
    // Pour ce projet, on simplifie : l'élève verra ses créneaux sur l'agenda.
    // Si tu veux la liste réelle, dis-le moi, on passera par une autre méthode.
}

function logout() { localStorage.clear(); location.reload(); }
