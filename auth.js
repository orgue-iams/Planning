const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxcJzXEDx5f0o59jRX4U9EUhE3Bsdlw5Bl_X4SkKLqdcSHn99atQ-6qnxoK6aO7EL3X/exec";
const REPO_PATH = "orgue-iams/orgue-iams.github.io";

// RÉCUPÉRATION AUTOMATIQUE DU BUILD VIA GITHUB API
async function fetchLastBuild() {
    try {
        const response = await fetch(`https://api.github.com/repos/${REPO_PATH}/commits/main`);
        if (!response.ok) throw new Error();
        const data = await response.json();
        const commitId = data.sha.substring(0, 7);
        const commitDate = new Date(data.commit.author.date).toLocaleDateString('fr-FR');
        document.querySelectorAll('.version-display').forEach(el => el.innerText = `Build: ${commitId} (${commitDate})`);
    } catch (e) {
        document.querySelectorAll('.version-display').forEach(el => el.innerText = "v1.2.5-stable");
    }
}

document.addEventListener('DOMContentLoaded', () => {
    fetchLastBuild();
    // Si l'utilisateur est déjà connecté
    if (localStorage.getItem('orgue_user')) {
        if (typeof showApp === "function") showApp();
    }
});

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

// CONNEXION
async function login() {
    const msg = document.getElementById('loginMessage');
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const pass = document.getElementById('userPass').value.trim();
    
    if(!email || !pass) {
        msg.style.color = "#d9534f";
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
            showApp();
        } else { 
            msg.style.color = "#d9534f";
            msg.innerText = "Identifiants incorrects."; 
        }
    } catch (e) { 
        toggleLoader(false);
        msg.innerText = "Erreur de connexion serveur."; 
    }
}

// MOT DE PASSE OUBLIÉ (AUTOMATIQUE)
async function handleForgotPassword(e) {
    e.preventDefault();
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const msg = document.getElementById('loginMessage');

    if (!email) {
        msg.style.color = "#d9534f";
        msg.innerText = "Saisissez votre email ci-dessus d'abord.";
        return;
    }

    if (!confirm(`Envoyer votre mot de passe à ${email} ?`)) return;

    toggleLoader(true);
    try {
        const url = `${SCRIPT_URL}?action=forgotPassword&email=${encodeURIComponent(email)}`;
        const response = await fetch(url, { method: 'GET', redirect: 'follow' });
        const data = await response.json();
        toggleLoader(false);

        if (data.result === "success") {
            msg.style.color = "#10b981"; // Vert pour succès
            msg.innerText = "Email envoyé ! Vérifiez vos courriers.";
        } else {
            msg.style.color = "#d9534f";
            msg.innerText = "Email inconnu dans la base.";
        }
    } catch (err) {
        toggleLoader(false);
        msg.innerText = "Erreur d'envoi.";
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
