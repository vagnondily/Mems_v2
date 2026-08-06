import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: true,          /* indispensable pour déboguer une version compilée */
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        /* Forme FONCTION du découpage manuel : c'est celle que comprennent à la
           fois Rollup (vite ≤ 7) et Rolldown (le bundler par défaut de vite 8).
           La forme objet `{ nom: [modules] }` n'est plus acceptée par Rolldown.
           On regroupe par chemin dans node_modules — react et sa famille
           (react-dom, scheduler, react-is) ensemble, recharts et ses dépendances
           d3 dans « charts », leaflet dans « carte ». Le fragment « sheets » a
           disparu avec la dépendance xlsx : les XLSForms sont lus côté serveur. */
        manualChunks(id){
          if(!id.includes("node_modules")) return;
          if(/[\\/]node_modules[\\/](react|react-dom|scheduler|react-is)[\\/]/.test(id)) return "react";
          if(/[\\/]node_modules[\\/](recharts|d3-|victory-|internmap)[\\/]/.test(id)) return "charts";
          if(/[\\/]node_modules[\\/]leaflet[\\/]/.test(id)) return "carte";
        },
      },
    },
  },
  server: {
    /* IPv4 explicite — c'était l'objet du réglage d'origine — mais sur la seule
       interface de bouclage. Écouter sur 0.0.0.0 exposait le serveur de
       développement à tout le réseau local, ce qui est la précondition des
       failles connues de Vite 5 (lecture de fichiers du projet depuis un autre
       poste, et sous Windows lecture hors du projet). Le transfert de port d'un
       Codespace se fait vers 127.0.0.1 dans le conteneur : rien n'est perdu.
       VITE_HOST reste disponible pour les cas qui exigent vraiment l'exposition. */
    host: process.env.VITE_HOST || "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: "http://localhost:4000", changeOrigin: true } },
  },
});
