const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxB91NR5jUeizC6zsMj1TTYxIjaEQt-hiCzaQZe3dbUy0G-LnXfiu_IXHuySjaPehzq/exec";

window.onload = () => {
    // Vérification de la connexion automatique
    const savedUser = localStorage.getItem('orgue_user');
    const savedPass = localStorage.getItem('orgue_pass');
    
    if(savedUser && savedPass) {
        showApp();
    }
    setInterval(refreshCalendar, 60000);
};

function login() {
    const email = document.getElementById('userEmail').value.toLowerCase().trim();
    const pass = document.getElementById('userPass').value.trim();
    const remember = document.getElementById('rememberMe').checked;
    const btn = document.getElementById('btnLogin');

    if(!email || !pass) return alert("Veuillez remplir tous les champs.");

    btn.disabled = true;
    btn.innerText = "Vérification...";

    // On utilise l'action list pour vérifier les identifiants
    fetch(`${SCRIPT_URL}?action=login&email=${email}&password=${pass}`)
    .then(r => r.json())
    .then(data => {
        if(data.result === "success") {
            if(remember) {
                localStorage.setItem('orgue_user', email);
                localStorage.setItem('orgue_pass', pass);
            } else {
                // Session temporaire (s'efface à la fermeture de l'onglet si on voulait, 
                // mais ici on garde au moins pour la navigation actuelle)
                sessionStorage.setItem('orgue_user', email);
                sessionStorage.setItem('orgue_pass', pass);
            }
            showApp();
        } else {
            alert("Email ou mot de passe incorrect.");
            btn.disabled = false;
            btn.innerText = "Se connecter";
        }
    })
    .catch(() => alert("Erreur de connexion au serveur."));
}

function getUser() { return localStorage.getItem('orgue_user') || sessionStorage.getItem('orgue_user'); }
function getPass() { return localStorage.getItem('orgue_pass') || sessionStorage.getItem('orgue_pass'); }

function showApp() {
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('appSection').style.display = 'block';
    document.getElementById('navBar').style.display = 'flex';
}

function refreshCalendar() {
    const cal = document.getElementById('googleCal');
    if(!cal) return;
    const url = new URL(cal.src);
    url.searchParams.set('t', new Date().getTime());
    cal.src = url.toString();
}

function openModal(id) {
    closeModals();
    document.getElementById(id).style.display = 'block';
}

function closeModals() {
    document.getElementById('modalResa').style.display = 'none';
    document.getElementById('modalListe').style.display = 'none';
}

function sendReservation() {
    const start = document.getElementById('eventStart').value;
    const end = document.getElementById('eventEnd').value;
    if(!start || !end) return alert("Dates manquantes");

    const btn = document.getElementById('btnResa');
    btn.disabled = true; btn.innerText = "⏳ Vérification...";

    const data = { 
        action: "reserve", 
        email: getUser(), 
        password: getPass(), 
        start: start, 
        end: end 
    };

    fetch(SCRIPT_URL, { method: 'POST', body: JSON.stringify(data) })
    .then(r => r.json())
    .then(res => {
        if(res.result === "error") alert(res.message);
        else {
            alert("Réservé !");
            closeModals();
            setTimeout(refreshCalendar, 1500);
        }
        btn.disabled = false; btn.innerText = "Confirmer";
    });
}

function showMyEvents() {
    openModal('modalListe');
    const listDiv = document.getElementById('mesEventsList');
    listDiv.innerHTML = "Recherche...";
    
    fetch(`${SCRIPT_URL}?action=list&email=${getUser()}&password=${getPass()}`)
    .then(r => r.json())
    .then(data => {
        if(!data.events || data.events.length === 0) {
            listDiv.innerHTML = "Aucun cours réservé."; return;
        }
        listDiv.innerHTML = data.events.map(ev => `
            <div class="event-item">
                <span>${ev.start}</span>
                <button class="btn-del" onclick="deleteEvent('${ev.id}')">Suppr.</button>
            </div>
        `).join('');
    });
}

function deleteEvent(id) {
    if(!confirm("Supprimer ce créneau ?")) return;
    const data = { action: "delete", id: id, email: getUser(), password: getPass() };
    fetch(SCRIPT_URL, { method: 'POST', body: JSON.stringify(data) })
    .then(() => {
        alert("Supprimé !");
        closeModals();
        setTimeout(refreshCalendar, 1500);
    });
}

function logout() {
    localStorage.clear();
    sessionStorage.clear();
    location.reload();
}
