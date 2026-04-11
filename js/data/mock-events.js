/**
 * Données de test pour la semaine du 6 avril 2026.
 * Titres d’exemple ; le motif (type) est dans extendedProps.type.
 */

export const demoEvents = [
    // --- LUNDI 6 AVRIL ---
    {
        title: 'Travail',
        start: '2026-04-06T09:00:00',
        end: '2026-04-06T10:30:00',
        extendedProps: { owner: 'eleve1@iams.fr', ownerDisplayName: 'Élève 1', ownerRole: 'eleve', type: 'reservation' }
    },
    {
        title: 'Travail',
        start: '2026-04-06T14:00:00',
        end: '2026-04-06T14:30:00',
        extendedProps: { owner: 'eleve2@iams.fr', ownerDisplayName: 'Élève 2', ownerRole: 'eleve', type: 'reservation' }
    },

    // --- MARDI 7 AVRIL ---
    {
        title: 'Maintenance',
        start: '2026-04-07T08:00:00',
        end: '2026-04-07T12:00:00',
        extendedProps: { owner: 'admin@iams.fr', ownerDisplayName: 'Admin IAMS', ownerRole: 'admin', type: 'reservation' }
    },
    {
        title: 'Cours',
        start: '2026-04-07T15:00:00',
        end: '2026-04-07T17:00:00',
        extendedProps: {
            owner: 'prof@iams.fr',
            ownerDisplayName: 'Prof IAMS',
            ownerRole: 'prof',
            type: 'cours',
            inscrits: ['eleve1@iams.fr', 'eleve2@iams.fr']
        }
    },

    // --- MERCREDI 8 AVRIL ---
    {
        title: 'Travail',
        start: '2026-04-08T10:00:00',
        end: '2026-04-08T10:30:00',
        extendedProps: { owner: 'eleve1@iams.fr', ownerDisplayName: 'Élève 1', ownerRole: 'eleve', type: 'reservation' }
    },
    {
        title: 'Fermeture',
        start: '2026-04-08T18:00:00',
        end: '2026-04-08T22:00:00',
        extendedProps: { owner: 'admin@iams.fr', ownerDisplayName: 'Admin IAMS', ownerRole: 'admin', type: 'fermeture' }
    },

    // --- JEUDI 9 AVRIL ---
    {
        title: 'Travail',
        start: '2026-04-09T11:00:00',
        end: '2026-04-09T12:30:00',
        extendedProps: { owner: 'eleve2@iams.fr', ownerDisplayName: 'Élève 2', ownerRole: 'eleve', type: 'reservation' }
    },

    // --- VENDREDI 10 AVRIL ---
    {
        title: 'Cours',
        start: '2026-04-10T09:00:00',
        end: '2026-04-10T09:30:00',
        extendedProps: {
            owner: 'prof@iams.fr',
            ownerDisplayName: 'Prof IAMS',
            ownerRole: 'prof',
            type: 'cours',
            inscrits: ['eleve2@iams.fr']
        }
    }
];
