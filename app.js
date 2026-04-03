const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyjAOy5X9-8hIKA14rj_EIWb0dlGIbRzzq-Ge9olyOVbgkCGBH0Hq2XVQI3s7KtYMG8/exec";

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
    const emailInput = document.getElementById('userEmail').value;
    const passInput = document.getElementById('userPass').value;
    const remember = document.getElementById('rememberMe').checked;
    const btn = document.getElementById('btnLogin');

    if(!emailInput || !passInput) return alert("Champs vides");

    const email = emailInput.toLowerCase().trim();
    const pass = passInput.trim();

    btn.disabled = true;
    btn.innerText = "Connexion en cours...";

    // Utilisation de URLSearchParams pour éviter les erreurs de caractères spéciaux
    const params = new URLSearchParams({
        action: 'login',
        email: email,
        password: pass
    });

    fetch(`${SCRIPT_URL}?${params.toString()}`)
    .then(response => {
        if (!response.ok) throw new Error('Erreur réseau');
        return response.json();
    })
    .then(data => {
        if(data.result === "success") {
            // On stocke les identifiants
            localStorage.setItem('orgue_user', email);
            localStorage.setItem('orgue_pass', pass);
            // On affiche l'app
            showApp(); 
        } else {
            alert("Identifiants incorrects");
            btn.disabled = false;
            btn.innerText = "Se connecter";
        }
    })
    .catch(error => {
        console.error('Erreur:', error);
        alert("Le serveur ne répond pas. Vérifiez votre connexion.");
        btn.disabled = false;
        btn.innerText = "Se connecter";
    });
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
