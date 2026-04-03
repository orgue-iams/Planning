const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxbG2yrQeZ1FI0_RMR7ILDgtkN4dyQUt49eNRA4uKNOozLIJtjCmSRf8OnZEKyTlzfA/exec";

window.onload = () => {
    if(localStorage.getItem('orgue_auth') === 'true') showApp();
};

function login() {
    const email = document.getElementById('userEmail').value;
    if(email) {
        localStorage.setItem('orgue_auth', 'true');
        localStorage.setItem('orgue_user_email', email.toLowerCase());
        showApp();
    }
}

function showApp() {
    document.getElementById('loginSection').style.display = 'none';
    document.getElementById('appSection').style.display = 'block';
}

function logout() {
    localStorage.clear();
    location.reload();
}

function sendReservation() {
    const startVal = document.getElementById('eventStart').value;
    const endVal = document.getElementById('eventEnd').value;
    const status = document.getElementById('status');

    if(!startVal || !endVal) return alert("Dates manquantes");

    const start = new Date(startVal);
    const end = new Date(endVal);

    if(start.getHours() < 8 || end.getHours() > 23 || (end.getHours() === 23 && end.getMinutes() > 0)) {
        return alert("Horaires autorisés : 08:00 à 23:00");
    }

    status.innerText = "⏳ Vérification...";
    
    fetch(SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors',
        body: JSON.stringify({
            email: localStorage.getItem('orgue_user_email'),
            start: startVal,
            end: endVal
        })
    }).then(() => {
        status.innerText = "✅ Réservé !";
        // Rafraîchissement forcé de l'iframe
        const cal = document.getElementById('googleCal');
        cal.src = cal.src;
        
        setTimeout(() => { status.innerText = ""; }, 5000);
    });
}
