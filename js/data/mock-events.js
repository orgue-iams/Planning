/**
 * Données de test pour la semaine du 6 avril 2026
 * Roles: 2 élèves, 1 Prof, 1 Admin (Maintenance/Fermeture)
 */

export const demoEvents = [
    // --- LUNDI 6 AVRIL ---
    {
        title: 'Jean (Élève 1)',
        start: '2026-04-06T09:00:00',
        end: '2026-04-06T10:30:00', // 1h30 -> Affichera Titre + Heure
        extendedProps: { owner: 'eleve1@iams.fr', ownerDisplayName: 'Élève 1', ownerRole: 'eleve', type: 'reservation' }
    },
    {
        title: 'Marie (Élève 2)',
        start: '2026-04-06T14:00:00',
        end: '2026-04-06T14:30:00', // 30min -> Affichera TITRE SEUL (centré)
        extendedProps: { owner: 'eleve2@iams.fr', ownerDisplayName: 'Élève 2', ownerRole: 'eleve', type: 'reservation' }
    },

    // --- MARDI 7 AVRIL ---
    {
        title: 'MAINTENANCE ANNUELLE',
        start: '2026-04-07T08:00:00',
        end: '2026-04-07T12:00:00', // Long créneau Admin
        extendedProps: { owner: 'admin@iams.fr', ownerDisplayName: 'Admin IAMS', ownerRole: 'admin', type: 'cours' }
    },
    {
        title: 'Prof. Durif',
        start: '2026-04-07T15:00:00',
        end: '2026-04-07T17:00:00',
        extendedProps: { owner: 'prof@iams.fr', ownerDisplayName: 'Prof IAMS', ownerRole: 'prof', type: 'reservation' }
    },

    // --- MERCREDI 8 AVRIL ---
    {
        title: 'Jean (Élève 1)',
        start: '2026-04-08T10:00:00',
        end: '2026-04-08T10:30:00', // 30min
        extendedProps: { owner: 'eleve1@iams.fr', ownerDisplayName: 'Élève 1', ownerRole: 'eleve', type: 'reservation' }
    },
    {
        title: 'FERMETURE CONCERT',
        start: '2026-04-08T18:00:00',
        end: '2026-04-08T22:00:00',
        extendedProps: { owner: 'admin@iams.fr', ownerDisplayName: 'Admin IAMS', ownerRole: 'admin', type: 'fermeture' }
    },

    // --- JEUDI 9 AVRIL ---
    {
        title: 'Marie (Élève 2)',
        start: '2026-04-09T11:00:00',
        end: '2026-04-09T12:30:00',
        extendedProps: { owner: 'eleve2@iams.fr', ownerDisplayName: 'Élève 2', ownerRole: 'eleve', type: 'reservation' }
    },

    // --- VENDREDI 10 AVRIL ---
    {
        title: 'Répétition Prof',
        start: '2026-04-10T09:00:00',
        end: '2026-04-10T09:30:00', // 30min
        extendedProps: { owner: 'prof@iams.fr', ownerDisplayName: 'Prof IAMS', ownerRole: 'prof', type: 'reservation' }
    }
];
