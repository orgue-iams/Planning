const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbz1cnIvKmQsWAfF7XNy456Fk2BJk049YuSErR0-3tfcD2Tv-KBnNGU2KbcWoNa8OJH7/exec";
const REPO_PATH = "orgue-iams/orgue-iams.github.io";

async function fetchLastBuild() {
    // On met une version par défaut immédiatement
    document.querySelectorAll('.version-display').forEach(el => el.innerText = "v1.4.6-stable");
    
    try {
        // On tente de récupérer le build, mais sans bloquer si ça échoue
        const res = await fetch(`https://api.github.com/repos/${REPO_PATH}/commits`);
        if (res.ok) {
            const data = await res.json();
            if (data && data[0]) {
                const buildInfo = `Build: ${data[0].sha.substring(0, 7)} (${new Date(data[0].commit.author.date).toLocaleDateString('fr-FR')})`;
                document.querySelectorAll('.version-display').forEach(el => el.innerText = buildInfo);
            }
        }
    } catch (e) {
        console.log("Info: Impossible de récupérer le numéro de build GitHub.");
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
    // Nettoyage des espaces pour éviter les erreurs de frappe
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
        } else { 
            msg.style.color = "#ef4444"; 
            msg.innerText = "Identifiants invalides"; 
        }
    } catch (e) { 
        toggleLoader(false); 
        msg.innerText = "Erreur serveur"; 
    }
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
        if(data.result === "success") { 
            msg.style.color = "#10b981"; 
            msg.innerText = "Email envoyé !"; 
        } else { 
            msg.style.color = "#ef4444"; 
            msg.innerText = "Utilisateur inconnu"; 
        }
    } catch (e) { 
        toggleLoader(false); 
        msg.innerText = "Erreur d'envoi"; 
    }
}

function logout() { localStorage.clear(); location.reload(); }
function toggleLoader(s) { document.getElementById('loader').style.display = s ? 'flex' : 'none'; }
