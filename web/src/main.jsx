import "./index.css";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { CSS } from "./lib/constants.js";

/* La feuille de style de l'application est injectée une seule fois. */
const style = document.createElement("style");
style.textContent = CSS;
document.head.appendChild(style);

createRoot(document.getElementById("root")).render(
  <React.StrictMode><App /></React.StrictMode>
);
