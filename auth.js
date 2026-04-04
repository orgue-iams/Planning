const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbz1cnIvKmQsWAfF7XNy456Fk2BJk049YuSErR0-3tfcD2Tv-KBnNGU2KbcWoNa8OJH7/exec";

document.addEventListener('DOMContentLoaded', () => {
    // Si l'utilisateur est déjà connecté en local
    if (localStorage.getItem('orgue_user')) {
        showApp();
    }
});

function togglePasswordVisibility() {
    const input = document.getElementById('userPass');
    const icon = document.getElementById('togglePassword');
    if (input.type === "password") {
        input.type = "text";
        icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
        input.type = "password";
        icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
}

async function login() {
    const email = document.getElementById('userEmail').value.trim().toLowerCase();
    const pass = document.getElementById('userPass').value.trim();
    const msg = document.getElementById('loginMessage');
    
    if(!email || !pass) {
        msg.innerText = "Veuillez remplir tous les champs.";
        msg.style.color = "#ef4444";
        return;
    }
    
    toggleLoader(true);
    msg.innerText = "";

    try {
        const url = `${SCRIPT_URL}?action=login&email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.result === "success") {
            localStorage.setItem('orgue_user', email);
            localStorage.setItem('orgue_name', data.name);
            toggleLoader(false);
            showApp();
        } else {
            toggleLoader(false);
            msg.style.color = "#ef4444";
            msg.innerText = data.message || "Identifiants incorrects";
        }
    } catch (error) {
        toggleLoader(false);
        msg.style.color = "#ef4444";
        msg.innerText = "Erreur de liaison avec le serveur.";
        console.error("Erreur login:", error);
    }
}

function showApp() {
    // Basculement visuel des sections
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('appSection').style.display = 'block';
    
    // Affichage du nom
    const name = localStorage.getItem('orgue_name');
    document.getElementById('userNameDisplay').innerText = name || "Utilisateur";
    
    // Lancement du calendrier (défini dans app.js)
    if (typeof initCalendar === "function") {
        initCalendar();
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
