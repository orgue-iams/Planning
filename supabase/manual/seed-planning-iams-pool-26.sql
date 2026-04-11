-- Pool : 26 calendriers « Planning IAMS 01 » … « Planning IAMS 26 » (compte orgue.iams / IAMS).
-- Autre déploiement : remplacer les google_calendar_id par ceux de votre export Apps Script.
-- Exécuter dans Supabase → SQL Editor après migration 007.
-- Idempotent : on conflict sur google_calendar_id → ne rien faire.

insert into public.google_calendar_pool (google_calendar_id, label, sort_order)
values
    ('c097075644499f0708e76ee3101dce67c04258dd1d6691a1b8903a9376fa560d@group.calendar.google.com', 'Planning IAMS 01', 1),
    ('fa4fbcde6a85f9030e7034f54881ec717290e9838e00f61c5c8a3551be592962@group.calendar.google.com', 'Planning IAMS 02', 2),
    ('1a265aa7a14bea326301fc068db4fb97c2d13a96696af03e92465ab14d172c40@group.calendar.google.com', 'Planning IAMS 03', 3),
    ('68858e6c0e861119bbb8e083c7ce439627f0c63deac0dd3dc02018ca4812e8b8@group.calendar.google.com', 'Planning IAMS 04', 4),
    ('9e3c9f0b036ddd68f29e7585f264ddc65a657928ff9f2cf6ddafbfce57930e1d@group.calendar.google.com', 'Planning IAMS 05', 5),
    ('608c28373a1a2ada09beec78f5af912a31c7a2d59d3732ccc2d178291b6d5784@group.calendar.google.com', 'Planning IAMS 06', 6),
    ('5012153fd5133547a0d8f99088463393e0f735d929d2490ad19d9ac41c037dde@group.calendar.google.com', 'Planning IAMS 07', 7),
    ('5b7993cf0f63302d6cb9274eb2333bc90c907859b8826cb750b5d5f0ce8f3466@group.calendar.google.com', 'Planning IAMS 08', 8),
    ('7e6d6b0b39beaf33df45a4d571d38401540efe852e21544bc15454a83488b58e@group.calendar.google.com', 'Planning IAMS 09', 9),
    ('a8e2f8948dcf16d38ae9e142819e3b6e3903cdf91fdece4deb1189f3cb204f37@group.calendar.google.com', 'Planning IAMS 10', 10),
    ('472f429541882d7cc2834138402768041c946f7de3b6fbf7cf2e98dd8a3fffb6@group.calendar.google.com', 'Planning IAMS 11', 11),
    ('5fbcdf8a786ba4fef4046def8236a50210c88a7df82e639727313e1505aa4b37@group.calendar.google.com', 'Planning IAMS 12', 12),
    ('165528e82edd4c7299928dcc3e5971e68063b38d7122b08afcfd76a2855d8288@group.calendar.google.com', 'Planning IAMS 13', 13),
    ('8f2209a814daf25c9c6a18a77bce7c4eedf12619e1b6580e6fd2f88896b09891@group.calendar.google.com', 'Planning IAMS 14', 14),
    ('765b6053665c8d02cbcc5803d2fa8a4a48a324e132a1955052790ddb0b2ffb3c@group.calendar.google.com', 'Planning IAMS 15', 15),
    ('a829ea7d179090cfc946c6dc4db587e8fe79da75b7deb5eba20d96253146aa02@group.calendar.google.com', 'Planning IAMS 16', 16),
    ('92b76f253202d25f6a5329be73f86874c309aebb652933c74af1c7c12c8ed40b@group.calendar.google.com', 'Planning IAMS 17', 17),
    ('b6b2e0da120e80775555aedcd19b378d11fb0aa15c5fe17b695f65e74154e134@group.calendar.google.com', 'Planning IAMS 18', 18),
    ('1651301f16788afee87b5ccea29d444f0877ecbd44636c236fc2169998fc1fff@group.calendar.google.com', 'Planning IAMS 19', 19),
    ('7de4afb06c4e8231e33321cf06b41941b2361a66cc47df6e3e35870d8c5ff038@group.calendar.google.com', 'Planning IAMS 20', 20),
    ('669a32ec2639c51137eec31edb189ecb40b392903e470d51e6b19dce6650895f@group.calendar.google.com', 'Planning IAMS 21', 21),
    ('832f45dfbf53b26f4e99c6e235af331d2b4de6c5e99ce4815ac4e7e6a683a77f@group.calendar.google.com', 'Planning IAMS 22', 22),
    ('70069ada02cdb852841885857967b7723997fe8217cfff4e1ce3fad1de2898b1@group.calendar.google.com', 'Planning IAMS 23', 23),
    ('6a0f465edf511bbb09f2b9b988b1d94d40d0634479d54b67e23d865b51222072@group.calendar.google.com', 'Planning IAMS 24', 24),
    ('584bbdcd67012321ed9ab673ce34c76565dab1974d53cbaa7e940dc4bf4fbb1c@group.calendar.google.com', 'Planning IAMS 25', 25),
    ('56b74c49d9555fe43875d154a54fe5c97249c5df9851cfcf30b8ed62522e4d63@group.calendar.google.com', 'Planning IAMS 26', 26)
on conflict (google_calendar_id) do nothing;

select public.planning_backfill_unassigned_calendars();
