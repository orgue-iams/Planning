// CONFIGURATION
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxcJzXEDx5f0o59jRX4U9EUhE3Bsdlw5Bl_X4SkKLqdcSHn99atQ-6qnxoK6aO7EL3X/exec";
const REPO_PATH = "orgue-iams/orgue-iams.github.io"; // Ton dépôt GitHub

// RÉCUPÉRATION AUTOMATIQUE DU BUILD VIA GITHUB API
async function fetchLastBuild() {
    try {
        const response = await fetch(`https://api.github.com/repos/${REPO_PATH}/commits/main`);
        if (!response.ok) throw new Error();
        const data = await response.json();
        
        // On récupère les 7 premiers caractères du commit SHA et la date
        const commitId = data.sha.substring(0, 7);
        const commitDate = new Date(data.commit.author.date).toLocaleDateString('fr-FR');
        
        const buildInfo = `Build: ${commitId} (${commitDate})`;
        document.querySelectorAll('.version-display').forEach(el => el.innerText = buildInfo);
    } catch (e) {
        // En cas d'erreur ou de limite d'API, on affiche une version par défaut
        document.querySelectorAll('.version-display').forEach(el => el.innerText = "v1.2.1-static");
    }
}

// INITIALISATION AU CHARGEMENT
document.addEventListener('DOMContentLoaded', () => {
    fetchLastBuild();
    if (localStorage.getItem('orgue_user')) {
        if (typeof showApp === "function") showApp();
    }
});

// GESTION DU MOT DE PASSE
function togglePasswordVisibility() {
    const passInput = document.getElementById('userPass');
    const icon = document.getElementById('togglePassword');
    if (passInput.type === "password") {
        passInput.type = "text";
        icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
        passInput.type = "password";
        icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
}

// LOGIQUE DE CONNEXION
async function login() {
    const msg = document.getElementById('loginMessage');
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const pass = document.getElementById('userPass').value.trim();
    
    if(!email || !pass) {
        msg.innerText = "Veuillez remplir tous les champs.";
        return;
    }

    const url = `${SCRIPT_URL}?action=login&email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`;
    
    toggleLoader(true);
    try {
        const response = await fetch(url, { method: 'GET', redirect: 'follow' });
        const data = await response.json();
        toggleLoader(false);
        
        if (data.result === "success") {
            localStorage.setItem('orgue_user', email);
            localStorage.setItem('orgue_name', data.name);
            showApp(); // Cette fonction est dans app.js
        } else { 
            msg.innerText = "Identifiants incorrects."; 
        }
    } catch (e) { 
        toggleLoader(false);
        msg.innerText = "Erreur de connexion serveur."; 
    }
}

function logout() { 
    localStorage.clear(); 
    location.reload(); 
}

function toggleLoader(show) {
    const loader = document.getElementById('loader');
    if (loader) loader.style.display = show ? 'flex' : 'none';
}
