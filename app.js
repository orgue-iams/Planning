const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyfUgkPbQofGALRfUHRSU-1UPLPOevxiUyt6HH63C2EmroZO0dMRACSl1hoUZCaFoc/exec";

window.onload = () => {
    const user = localStorage.getItem('orgue_user') || sessionStorage.getItem('orgue_user');
    if(user) showApp();
};

function togglePassword() {
    const passInput = document.getElementById('userPass');
    const eyeBtn = document.querySelector('.eye-btn');
    passInput.type = (passInput.type === "password") ? "text" : "password";
    eyeBtn.style.opacity = (passInput.type === "text") ? "1" : "0.5";
}

async function login() {
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const pass = document.getElementById('userPass').value.trim();
    const remember = document.getElementById('rememberMe').checked;
    const btn = document.getElementById('btnLogin');

    if(!email || !pass) return alert("Champs vides.");
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
            alert("Erreur d'identification.");
            btn.disabled = false; btn.innerText = "Se connecter";
        }
    } catch(e) {
        alert("Erreur serveur.");
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
    const start = new Date(`${day}T${document.getElementById('startH').value}:${document.getElementById('startM').value}:00`);
    const end = new Date(`${day}T${document.getElementById('endH').value}:${document.getElementById('endM').value}:00`);

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
            closeModals(); // On ferme tout de suite
            refreshCalendar();
            setTimeout(() => { alert("Réservation confirmée !"); }, 500);
        } else { 
            alert(res.message); 
        }
    } catch(e) { 
        alert("La requête a pris trop de temps, mais vérifiez le calendrier car elle a pu passer."); 
    }
    
    btn.disabled = false; btn.innerText = "Confirmer";
}

function showMyEvents() {
    const listDiv = document.getElementById('mesEventsList');
    listDiv.innerHTML = "Chargement...";
    document.getElementById('modalListe').style.display = 'block';
    const email = localStorage.getItem('orgue_user') || sessionStorage.getItem('orgue_user');
    const pass = localStorage.getItem('orgue_pass') || sessionStorage.getItem('orgue_pass');
    
    fetch(`${SCRIPT_URL}?action=list&email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`)
    .then(r => r.json()).then(data => {
        if(!data.events || data.events.length === 0) {
            listDiv.innerHTML = "<p style='text-align:center; padding:10px;'>Aucun cours.</p>";
        } else {
            listDiv.innerHTML = data.events.map(ev => `
                <div class="event-item-card">
                    <div class="event-info">
                        <strong>${ev.title}</strong><br>
                        <span>${ev.date} | ${ev.start} - ${ev.end}</span>
                    </div>
                    <button class="btn-del" onclick="deleteEvent('${ev.id}')">Suppr.</button>
                </div>
            `).join('');
        }
    });
}

async function deleteEvent(id) {
    if(!confirm("Supprimer cette réservation ?")) return;
    const email = localStorage.getItem('orgue_user') || sessionStorage.getItem('orgue_user');
    const pass = localStorage.getItem('orgue_pass') || sessionStorage.getItem('orgue_pass');
    
    try {
        const resp = await fetch(`${SCRIPT_URL}?action=delete&id=${encodeURIComponent(id)}&email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`);
        const res = await resp.json();
        if(res.result === "success") {
            showMyEvents();
            refreshCalendar();
        } else { alert("Erreur : " + res.message); }
    } catch(e) { alert("Erreur réseau."); }
}

function closeModals() { document.querySelectorAll('.modal').forEach(m => m.style.display = 'none'); }
function refreshCalendar() { const ifr = document.getElementById('googleCal'); if(ifr) ifr.src = ifr.src; }
function logout() { localStorage.clear(); sessionStorage.clear(); location.reload(); }
