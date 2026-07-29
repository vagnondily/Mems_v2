/* Tailwind était chargé depuis cdn.tailwindcss.com. Deux problèmes : la politique
   de sécurité du serveur interdit les scripts externes, donc l'application servie
   en production se retrouvait sans aucune mise en forme ; et un bureau de terrain
   à la connexion intermittente n'aurait rien affiché hors ligne.
   Les classes sont désormais compilées dans le bundle. */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: { extend: {} },
  plugins: [],
};
