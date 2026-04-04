async function fetchEvents(info, successCallback, failureCallback) {
    const email = localStorage.getItem('orgue_user');
    const url = `${SCRIPT_URL}?action=getEvents&email=${email}&start=${info.startStr}&end=${info.endStr}`;
    
    try {
        const response = await fetch(url);
        const result = await response.json();
        if (result.result === "success") {
            successCallback(result.data);
        } else {
            console.error("Erreur:", result.message);
        }
    } catch (error) {
        failureCallback(error);
    }
}
