import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { initStorage, storage, KEYS } from "./services/storage";

/* Boot sequence: hydrate the IndexedDB database (and run legacy migrations)
 * BEFORE React renders, so every storage read inside components is served
 * warm from the write-through replica. The static boot splash in index.html
 * covers the screen until the app mounts — no flash of unthemed content. */
async function boot() {
  try {
    await initStorage();
  } catch (e) {
    console.error("[InterviewHub] Database initialisation failed:", e);
  }

  // Apply the persisted theme pre-paint so the first frame is correct.
  const theme = (storage.get(KEYS.theme) as string) || "dark";
  document.documentElement.classList.toggle("dark", theme === "dark");

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

void boot();
