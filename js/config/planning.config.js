/**
 * Copier ce fichier et renseigner les valeurs (projet Supabase + URL Web App Apps Script).
 * Ne commitez pas de vraies clés dans un dépôt public : utilisez des secrets côté hébergeur
 * ou remplissez ce fichier uniquement sur le serveur de prod.
 *
 * Option 2 : Supabase = auth + profils ; Google Agenda = source des créneaux ;
 * Edge Function calendar-bridge = JWT utilisateur + API Google Calendar v3 (compte de service ou refresh token).
 * Edge Function planning-slot-notify = e-mail Brevo au propriétaire si un tiers modifie / déplace / supprime son créneau.
 */
window.__PLANNING_CONFIG__ = window.__PLANNING_CONFIG__ || {
    supabaseUrl: 'https://dqgzvddphbjibkszcdun.supabase.co',
    supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxZ3p2ZGRwaGJqaWJrc3pjZHVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0ODk4OTYsImV4cCI6MjA5MTA2NTg5Nn0.72X8hzNx0IWPuvmw-jCJvNtQWCclyW-xf3SEsffH3qM',
    /**
     * En production : URL de l’Edge Function.
     * Ex. https://<project-ref>.supabase.co/functions/v1/calendar-bridge
     * Elle vérifie le JWT puis appelle l’API Google Calendar (secrets GOOGLE_* côté Supabase).
     * Laisser vide + pas de clé Supabase = mode démo local inchangé.
     */
    calendarBridgeUrl: 'https://dqgzvddphbjibkszcdun.supabase.co/functions/v1/calendar-bridge',

    /**
     * ID du calendrier Google « général » (même valeur que GOOGLE_CALENDAR_ID côté calendar-bridge).
     * Sert aux liens d’abonnement / copie dans la modale Profil. Laisser vide = liens masqués.
     */
    mainGoogleCalendarId: 'orgue.iams@google.com',

    /** Nom affiché au-dessus du lien dans la modale Profil (sinon libellé par défaut côté app). */
    mainGoogleCalendarLabel: 'Planning général orgue'
};
