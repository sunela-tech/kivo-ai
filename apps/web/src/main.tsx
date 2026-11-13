import { ClerkProvider } from "@clerk/react";
import { dark } from "@clerk/ui/themes";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { Logo, Notice, Spinner } from "./components/ui";
import "./index.css";
import { api, type AppConfig } from "./lib/api";

/** Clerk components, tuned to Kivo's palette. */
export const clerkAppearance = {
  theme: dark,
  variables: {
    colorPrimary: "#8b7cf6",
    colorBackground: "#161b2b",
    colorInput: "#0e1322",
    colorForeground: "#eef0f7",
    colorMutedForeground: "#7f879f",
    colorBorder: "#262d42",
    borderRadius: "0.8rem",
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, sans-serif',
  },
};

function Boot() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The publishable key and the live plan table come from the server, so the web build has no baked-in configuration.
    api<AppConfig>("/config")
      .then(setConfig)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 p-6">
        <Logo size={36} />
        <Notice tone="bad" title="Kivo can't start">
          {error}
        </Notice>
      </div>
    );
  }
  if (!config) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  return (
    <ClerkProvider publishableKey={config.clerkPublishableKey} afterSignOutUrl="/" appearance={clerkAppearance}>
      <BrowserRouter>
        <App config={config} />
      </BrowserRouter>
    </ClerkProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
