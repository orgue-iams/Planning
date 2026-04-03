const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzbtervtORATCnDZ02BYj0nKg4LHGyl_HjMjKcOXBBB3VvMtQWBcZe0SI5l8DBXSpT6/exec";

window.onload = () => {
    const savedUser = localStorage.getItem('orgue_user');
    const savedPass = localStorage.getItem('orgue_pass');
    if(savedUser && savedPass) showApp();
    setInterval(refreshCalendar, 60000);
};

function showApp() {
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('appSection').style.display = 'flex';
    document.getElementById('navBar').style.display = 'flex';
}

function prepareReservation() {
    // On met le nom de l'élève par défaut dans le titre
    const userName = localStorage.getItem('orgue_name') || sessionStorage.getItem('orgue_name') || "Élève";
    document.getElementById('eventTitle').value = "🎹 " + userName;
    openModal('modalResa');
}

function login() {
    const email = document.getElementById('userEmail').value.toLowerCase().trim();
    const pass = document.getElementById('userPass').value.trim();
    const remember = document.getElementById('rememberMe').checked;
    const btn = document.getElementById('btnLogin');

    if(!email || !pass) return alert("Champs vides");
    btn.disabled = true; btn.innerText = "Connexion...";

    const params = new URLSearchParams({ action: 'login', email: email, password: pass });

    fetch(`${SCRIPT_URL}?${params.toString()}`)
    .then(r => r.json())
    .then(data => {
        if(data.result === "success") {
            const storage = remember ? localStorage : sessionStorage;
            storage.setItem('orgue_user', email);
            storage.setItem('orgue_pass', pass);
            storage.setItem('orgue_name', data.name); // On stocke le vrai nom
            showApp();
        } else {
            alert("Email ou mot de passe incorrect");
            btn.disabled = false; btn.innerText = "Se connecter";
        }
    }).catch(() => { alert("Erreur serveur"); btn.disabled = false; });
}

function sendReservation() {
    const title = document.getElementById('eventTitle').value;
    const start = document.getElementById('eventStart').value;
    const end = document.getElementById('eventEnd').value;
    
    if(!start || !end || !title) return alert("Veuillez remplir tous les champs.");

    const startDate = new Date(start);
    const endDate = new Date(end);

    if (endDate <= startDate) return alert("L'heure de fin est incohérente.");
    if ((endDate - startDate) / 60000 < 15) return alert("Minimum 15 minutes.");

    const btn = document.getElementById('btnResa');
    btn.disabled = true; btn.innerText = "Vérification...";

    const data = { 
        action: "reserve", 
        email: getUser(), 
        password: getPass(), 
        title: title,
        start: startDate.toISOString(), 
        end: endDate.toISOString() 
    };

    fetch(SCRIPT_URL, { method: 'POST', body: JSON.stringify(data) })
    .then(r => r.json())
    .then(res => {
        if(res.result === "error") alert(res.message);
        else { alert("Réservé !"); closeModals(); setTimeout(refreshCalendar, 1000); }
        btn.disabled = false; btn.innerText = "Confirmer";
    });
}

// --- Fonctions Utilitaires ---
function togglePassword() {
    const passInput = document.getElementById('userPass');
    const eyePath = document.querySelector('#eyeIcon path');
    if (passInput.type === "password") {
        passInput.type = "text";
        eyePath.setAttribute("d", "M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.82l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.74-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.73 10.03 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z");
    } else {
        passInput.type = "password";
        eyePath.setAttribute("d", "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z");
    }
}
function getUser() { return localStorage.getItem('orgue_user') || sessionStorage.getItem('orgue_user'); }
function getPass() { return localStorage.getItem('orgue_pass') || sessionStorage.getItem('orgue_pass'); }
function refreshCalendar() { const cal = document.getElementById('googleCal'); if(cal){ const url = new URL(cal.src); url.searchParams.set('t', Date.now()); cal.src = url.toString(); } }
function openModal(id) { closeModals(); document.getElementById(id).style.display = 'block'; }
function closeModals() { document.getElementById('modalResa').style.display = 'none'; document.getElementById('modalListe').style.display = 'none'; }
function showMyEvents() {
    openModal('modalListe');
    const listDiv = document.getElementById('mesEventsList');
    listDiv.innerHTML = "Chargement...";
    fetch(`${SCRIPT_URL}?action=list&email=${getUser()}&password=${getPass()}`)
    .then(r => r.json())
    .then(data => {
        if(!data.events || data.events.length === 0) listDiv.innerHTML = "Aucun cours.";
        else listDiv.innerHTML = data.events.map(ev => `<div class="event-item"><span>${ev.start}</span><button class="btn-del" onclick="deleteEvent('${ev.id}')">Suppr.</button></div>`).join('');
    });
}
function deleteEvent(id) { if(confirm("Supprimer ?")){ fetch(SCRIPT_URL, { method: 'POST', body: JSON.stringify({ action: "delete", id: id, email: getUser(), password: getPass() }) }).then(() => { closeModals(); setTimeout(refreshCalendar, 1000); }); } }
function logout() { localStorage.clear(); sessionStorage.clear(); location.reload(); }
