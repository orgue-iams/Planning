const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxGgTwoQny5bUjTj74uQ6gJOBQTqrXfW2VdfC2aB5-PP0LIpHtiate_LMPgwNh2cElO/exec";

window.onload = () => {
    if(localStorage.getItem('orgue_user')) showApp();
};

function login() {
    const email = document.getElementById('userEmail').value;
    if(!email) return alert("Email requis");
    localStorage.setItem('orgue_user', email.toLowerCase());
    showApp();
}

function showApp() {
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('appSection').style.display = 'block';
    document.getElementById('navBar').style.display = 'flex';
}

function openModal(id) {
    closeModals();
    document.getElementById(id).style.display = 'block';
}

function closeModals() {
    document.getElementById('modalResa').style.display = 'none';
    document.getElementById('modalListe').style.display = 'none';
}

function refreshCalendar() {
    const cal = document.getElementById('googleCal');
    const baseSrc = cal.src.split('&t=')[0];
    cal.src = baseSrc + '&t=' + new Date().getTime();
}

function sendReservation() {
    const start = document.getElementById('eventStart').value;
    const end = document.getElementById('eventEnd').value;
    const btn = document.getElementById('btnResa');

    if(!start || !end) return alert("Dates incomplètes");

    btn.disabled = true;
    btn.innerText = "Envoi...";

    const data = {
        action: "reserve",
        email: localStorage.getItem('orgue_user'),
        start: start,
        end: end
    };

    fetch(SCRIPT_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify(data) })
    .then(() => {
        alert("Réservation envoyée ! Attendez 2-3 sec que l'agenda se mette à jour.");
        closeModals();
        setTimeout(refreshCalendar, 2000);
        btn.disabled = false;
        btn.innerText = "Confirmer";
    })
    .catch(() => alert("Erreur de connexion"));
}

function logout() {
    localStorage.clear();
    location.reload();
}
