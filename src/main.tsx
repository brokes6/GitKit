import { createRoot } from "react-dom/client";
import "@fontsource-variable/manrope/wght.css";
import "@fontsource-variable/sora/wght.css";
import App from "./App.tsx";
import "./styles/index.css";

createRoot(document.getElementById("root")!).render(<App />);
