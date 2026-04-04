const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwMsVRa2hMrXr8B6tR64UDlfht1lmMvITRntZYKzVaUYeeWzFpMrsggINZylqT6dKpX/exec";
const REPO_PATH = "orgue-iams/orgue-iams.github.io";

// Récupère automatiquement le dernier commit de GitHub
async function fetchLastBuild() {
    try {
        const res = await fetch(`https://api.github.com/repos/${REPO_PATH}/commits/main`);
        const data = await res.json();
        const buildInfo = `Build: ${data.sha.substring(0, 7)} (${new Date(data.commit.author.date).toLocaleDateString('fr-FR')})`;
        document.querySelectorAll('.version-display').forEach(el => el.innerText = buildInfo);
    } catch (e) {
        document.querySelectorAll('.version-display').forEach(el => el.innerText = "v1.4.1-stable");
    }
}

document.addEventListener('DOMContentLoaded', () => {
    fetchLastBuild();
    if (localStorage.getItem('orgue_user')) showApp();
});

function togglePasswordVisibility() {
    const input = document.getElementById('userPass');
    const icon = document.getElementById('togglePassword');
    input.type = input.type === "password" ? "text" : "password";
    icon.classList.toggle('fa-eye'); icon.classList.toggle('fa-eye-slash');
}

async function login() {
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const pass = document.getElementById('userPass').value.trim();
    const msg = document.getElementById('loginMessage');
    if(!email || !pass) { msg.innerText = "Champs requis"; return; }
    
    toggleLoader(true);
    try {
        const res = await fetch(`${SCRIPT_URL}?action=login&email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`);
        const data = await res.json();
        toggleLoader(false);
        if (data.result === "success") {
            localStorage.setItem('orgue_user', email);
            localStorage.setItem('orgue_name', data.name);
            showApp();
        } else { msg.style.color = "#ef4444"; msg.innerText = "Identifiants invalides"; }
    } catch (e) { toggleLoader(false); msg.innerText = "Erreur serveur"; }
}

async function handleForgotPassword(e) {
    e.preventDefault();
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const msg = document.getElementById('loginMessage');
    if(!email) { msg.innerText = "Saisissez votre email"; return; }
    
    toggleLoader(true);
    try {
        const res = await fetch(`${SCRIPT_URL}?action=forgotPassword&email=${encodeURIComponent(email)}`);
        const data = await res.json();
        toggleLoader(false);
        if(data.result === "success") { msg.style.color = "#10b981"; msg.innerText = "Email envoyé !"; }
        else { msg.style.color = "#ef4444"; msg.innerText = "Utilisateur inconnu"; }
    } catch (e) { toggleLoader(false); msg.innerText = "Erreur d'envoi"; }
}

function logout() { localStorage.clear(); location.reload(); }
function toggleLoader(s) { document.getElementById('loader').style.display = s ? 'flex' : 'none'; }
