const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwk8lxyTHBFKIsFybMLH-E861B6rRDTj5VvVTbvpq2Q3tE3FPcp8r8esyGz2nl_cZE3/exec";
window.onload = () => {
    const user = localStorage.getItem('orgue_user') || sessionStorage.getItem('orgue_user');
    if(user) showApp();
};

function togglePassword() {
    const passInput = document.getElementById('userPass');
    const eyeBtn = document.querySelector('.eye-btn');
    if (passInput.type === "password") {
        passInput.type = "text";
        eyeBtn.style.opacity = "1";
    } else {
        passInput.type = "password";
        eyeBtn.style.opacity = "0.5";
    }
}

async function login() {
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const pass = document.getElementById('userPass').value.trim();
    const remember = document.getElementById('rememberMe').checked;
    const btn = document.getElementById('btnLogin');

    if(!email || !pass) return alert("Veuillez remplir les champs.");
    btn.disabled = true; btn.innerText = "Connexion...";

    try {
        const resp = await fetch(`${SCRIPT_URL}?action=login&email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`);
        const data = await resp.json();

        if(data.result === "success") {
            const storage = remember ? localStorage : sessionStorage;
            storage.setItem('orgue_user', email);
            storage.setItem('orgue_pass', pass);
            localStorage.setItem('orgue_name', data.name);
            showApp();
        } else {
            alert("Identifiants incorrects.");
            btn.disabled = false; btn.innerText = "Se connecter";
        }
    } catch(e) {
        alert("Erreur de connexion au serveur.");
        btn.disabled = false; btn.innerText = "Se connecter";
    }
}

function showApp() {
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('appSection').style.display = 'block';
    document.getElementById('navBar').style.display = 'flex';
}

function prepareReservation() {
    document.getElementById('eventTitle').value = localStorage.getItem('orgue_name') || "";
    document.getElementById('resDay').value = new Date().toISOString().split('T')[0];
    
    const hSels = [document.getElementById('startH'), document.getElementById('endH')];
    hSels.forEach(s => {
        s.innerHTML = "";
        for(let i=8; i<=22; i++) {
            let val = i < 10 ? '0'+i : i;
            s.innerHTML += `<option value="${val}">${i}h</option>`;
        }
    });
    document.getElementById('modalResa').style.display = 'block';
}

async function sendReservation() {
    const title = document.getElementById('eventTitle').value;
    const day = document.getElementById('resDay').value;
    const startH = document.getElementById('startH').value;
    const startM = document.getElementById('startM').value;
    const endH = document.getElementById('endH').value;
    const endM = document.getElementById('endM').value;

    const start = new Date(`${day}T${startH}:${startM}:00`);
    const end = new Date(`${day}T${endH}:${endM}:00`);

    if(end <= start) return alert("L'heure de fin doit être après le début.");

    const btn = document.getElementById('btnResa');
    btn.disabled = true; btn.innerText = "Envoi...";

    const params = new URLSearchParams({
        action: "reserve",
        email: localStorage.getItem('orgue_user') || sessionStorage.getItem('orgue_user'),
        password: localStorage.getItem('orgue_pass') || sessionStorage.getItem('orgue_pass'),
        title: title, start: start.toISOString(), end: end.toISOString()
    });

    try {
        const r = await fetch(`${SCRIPT_URL}?${params.toString()}`);
        const res = await r.json();
        if(res.result === "success") { 
            alert("Réservé !"); 
            closeModals(); 
            refreshCalendar(); 
        } else alert(res.message);
    } catch(e) { alert("Erreur réseau"); }
    btn.disabled = false; btn.innerText = "Confirmer";
}

function showMyEvents() {
    const listDiv = document.getElementById('mesEventsList');
    listDiv.innerHTML = "Chargement...";
    document.getElementById('modalListe').style.display = 'block';
    const email = localStorage.getItem('orgue_user') || sessionStorage.getItem('orgue_user');
    const pass = localStorage.getItem('orgue_pass') || sessionStorage.getItem('orgue_pass');
    
    fetch(`${SCRIPT_URL}?action=list&email=${email}&password=${pass}`)
    .then(r => r.json()).then(data => {
        if(!data.events || data.events.length === 0) listDiv.innerHTML = "Aucun cours.";
        else listDiv.innerHTML = data.events.map(ev => `<div style="display:flex; justify-content:space-between; margin-bottom:10px; padding:10px; border-bottom:1px solid #eee;"><span>${ev.start}</span> <button style="width:auto; padding:5px 10px; font-size:12px; background:#e74c3c" onclick="deleteEvent('${ev.id}')">Suppr.</button></div>`).join('');
    });
}

function deleteEvent(id) {
    if(!confirm("Supprimer cette réservation ?")) return;
    const email = localStorage.getItem('orgue_user') || sessionStorage.getItem('orgue_user');
    const pass = localStorage.getItem('orgue_pass') || sessionStorage.getItem('orgue_pass');
    fetch(`${SCRIPT_URL}?action=delete&id=${id}&email=${email}&password=${pass}`)
    .then(() => { closeModals(); refreshCalendar(); });
}

function closeModals() { document.querySelectorAll('.modal').forEach(m => m.style.display = 'none'); }
function refreshCalendar() { const ifr = document.getElementById('googleCal'); ifr.src = ifr.src; }
function logout() { localStorage.clear(); sessionStorage.clear(); location.reload(); }
