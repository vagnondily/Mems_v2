-- Indicateur COMPOSÉ : une formule libre entre indicateurs de la masterlist,
-- désignés par leur code (ex. « FCS / FES * 100 »). Une chaîne vide = indicateur
-- MESURÉ classique, avec ses propres outcomes ; une formule non vide = indicateur
-- CALCULÉ, sans mesures propres, dont le réalisé et le planifié se déduisent de
-- ses composants (formule appliquée sur leurs valeurs mesurées, puis planifiées).
ALTER TABLE indicators ADD COLUMN formula text NOT NULL DEFAULT '';
