import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import { registerSW } from "virtual:pwa-register";

const updateSW = registerSW({
  immediate: true,

  onNeedRefresh() {
    const shouldUpdate = window.confirm(
      "A new version of app is available. Update now?",
    );

    if (shouldUpdate) {
      updateSW(true);
    }
  },

  onOfflineReady() {
    console.log("App is ready to work offline.");
  },
});

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
