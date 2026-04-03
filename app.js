const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxbG2yrQeZ1FI0_RMR7ILDgtkN4dyQUt49eNRA4uKNOozLIJtjCmSRf8OnZEKyTlzfA/exec";

window.onload = () => {
    if(localStorage.getItem('orgue_auth') === 'true') showApp();
};

function login() {
    const email = document.getElementById('userEmail').value;
    if(email) {
        localStorage.setItem('orgue_auth', 'true');
        localStorage.setItem('orgue_user_email', email);
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
    const startInput = document.getElementById('eventStart').value;
    const endInput = document.getElementById('eventEnd').value;
    const status = document.getElementById('status');

    if(!startInput || !endInput) return alert("Dates manquantes");

    const start = new Date(startInput);
    const end = new Date(endInput);

    // Validation 8h - 23h
    if(start.getHours() < 8 || end.getHours() > 23 || (end.getHours() === 23 && end.getMinutes() > 0)) {
        return alert("Horaires autorisés : 08:00 à 23:00");
    }

    status.innerText = "Envoi...";
    
    fetch(SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors',
        body: JSON.stringify({
            email: localStorage.getItem('orgue_user_email'),
            start: startInput,
            end: endInput
        })
    }).then(() => {
        status.innerText = "✅ Réservé !";
        document.getElementById('googleCal').src += ''; // Refresh agenda
    });
}
