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
        manualChunks: {
          react: ["react", "react-dom"],
          charts: ["recharts"],
          /* Le fragment « sheets » a disparu avec la dépendance xlsx : les
             XLSForms sont désormais lus par le serveur (POST /api/xlsform/parse),
             qui a déjà exceljs. */
          carte: ["leaflet"],
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
