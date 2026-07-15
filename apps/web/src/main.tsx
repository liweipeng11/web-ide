import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { CapabilitiesProvider } from "./capabilities/CapabilitiesProvider";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CapabilitiesProvider>
      <App />
    </CapabilitiesProvider>
  </React.StrictMode>
);
