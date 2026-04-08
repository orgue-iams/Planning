/**
 * (Obsolète) L’intégration Google Agenda passe par l’Edge Function Supabase
 * `calendar-bridge`, qui appelle directement l’API Calendar v3.
 *
 * Voir : Planning/supabase/SETUP.txt (secrets GOOGLE_* et déploiement).
 * Vous pouvez supprimer tout projet Apps Script utilisé uniquement pour l’ancien pont.
 */

function doGet() {
  return ContentService.createTextOutput(
    'Pont Apps Script désactivé — utiliser calendar-bridge (API Google Calendar).'
  ).setMimeType(ContentService.MimeType.TEXT);
}
