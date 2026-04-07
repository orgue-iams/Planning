/**
 * Pont Google Agenda — déployer comme Web App (POST), exécuter en tant que le compte du calendrier.
 *
 * Paramètres du script → BRIDGE_SECRET : même valeur que le secret Supabase GOOGLE_BRIDGE_SECRET
 * (invisible navigateur : uniquement la Edge Function l’ajoute dans le JSON).
 *
 * JSON attendu : { "bridgeSecret": "…", "action": "upsert", "events": [ { "title","start","end","type","owner" } ] }
 * Après vérification, bridgeSecret est ignoré pour la logique métier.
 */

function doPost(e) {
  try {
    if (!e.postData || !e.postData.contents) {
      return jsonResponse({ ok: false, error: 'Corps vide' });
    }

    var body = JSON.parse(e.postData.contents);
    var expected = PropertiesService.getScriptProperties().getProperty('BRIDGE_SECRET');

    if (expected) {
      var provided = body.bridgeSecret;
      if (provided !== expected) {
        return jsonResponse({ ok: false, error: 'Forbidden' });
      }
    }

    delete body.bridgeSecret;
    delete body._relayUser;

    if (body.action === 'upsert' && body.events && body.events.length) {
      var calendar = CalendarApp.getDefaultCalendar();
      var n = 0;
      for (var i = 0; i < body.events.length; i++) {
        var ev = body.events[i];
        if (!ev.start || !ev.end || !ev.title) continue;
        calendar.createEvent(String(ev.title), new Date(ev.start), new Date(ev.end), {
          description: 'type=' + (ev.type || '') + ' owner=' + (ev.owner || '')
        });
        n++;
      }
      return jsonResponse({ ok: true, created: n });
    }

    return jsonResponse({ ok: false, error: 'Action ou payload inconnu' });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput('Orgue IAMS — pont agenda (POST).').setMimeType(
    ContentService.MimeType.TEXT
  );
}
