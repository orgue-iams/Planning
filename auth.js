const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbz1cnIvKmQsWAfF7XNy456Fk2BJk049YuSErR0-3tfcD2Tv-KBnNGU2KbcWoNa8OJH7/exec";

function fetchLastBuild() {
    document.querySelectorAll('.version-display').forEach(el => el.innerText = "v1.5.2-stable");
}

document.addEventListener('DOMContentLoaded', () => {
    fetchLastBuild();
    if (localStorage.getItem('orgue_user')) showApp();
});

async function login() {
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const pass = document.getElementById('userPass').value.trim();
    const msg = document.getElementById('loginMessage');
    
    if(!email || !pass) { msg.innerText = "Champs requis"; return; }
    
    toggleLoader(true);
    try {
        const url = `${SCRIPT_URL}?action=login&email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`;
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.result === "success") {
            localStorage.setItem('orgue_user', email);
            localStorage.setItem('orgue_name', data.name);
            toggleLoader(false);
            showApp(); // On change de page
        } else {
            toggleLoader(false);
            msg.innerText = data.message;
        }
    } catch (e) {
        toggleLoader(false);
        msg.innerText = "Erreur serveur";
    }
}

function showApp() {
    document.getElementById('loginSection').classList.add('hidden');
    document.getElementById('appSection').classList.remove('hidden');
    const name = localStorage.getItem('orgue_name');
    document.getElementById('userNameDisplay').innerText = name || "Utilisateur";
    if (window.initCalendar) initCalendar();
}

function logout() { localStorage.clear(); location.reload(); }
function toggleLoader(s) { document.getElementById('loader').style.display = s ? 'flex' : 'none'; }
