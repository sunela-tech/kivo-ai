import { Show, useAuth } from "@clerk/react";
import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/AppShell";
import { Loading } from "./components/ui";
import { setTokenGetter, type AppConfig } from "./lib/api";
import { SessionProvider } from "./lib/session";
import { AssetsPage } from "./pages/Assets";
import { CreatePage } from "./pages/Create";
import { HomePage } from "./pages/Home";
import { LandingPage } from "./pages/Landing";
import { ProjectPage } from "./pages/Project";
import { ProjectsPage } from "./pages/Projects";
import { RenderQueuePage } from "./pages/RenderQueue";
import { SettingsPage } from "./pages/Settings";
import { SubscriptionPage } from "./pages/Subscription";

// The 3D editor pulls in three.js; load it only when it is opened.
const EditorPage = lazy(() => import("./pages/Editor").then((m) => ({ default: m.EditorPage })));
const EditorIndexPage = lazy(() => import("./pages/Editor").then((m) => ({ default: m.EditorIndexPage })));

function SignedIn({ config }: { config: AppConfig }) {
  const { getToken } = useAuth();
  // Registered during render, not in an effect: child components start fetching in their own
  // effects, which run before this component's would.
  setTokenGetter(() => getToken());
  useEffect(() => () => setTokenGetter(null), []);

  return (
    <SessionProvider config={config}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route path="create" element={<CreatePage />} />
          <Route path="create/:projectId" element={<CreatePage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:projectId" element={<ProjectPage />} />
          <Route path="assets" element={<AssetsPage />} />
          <Route
            path="editor"
            element={
              <Suspense fallback={<Loading label="Loading the 3D editor" />}>
                <EditorIndexPage />
              </Suspense>
            }
          />
          <Route path="renders" element={<RenderQueuePage />} />
          <Route path="subscription" element={<SubscriptionPage />} />
          <Route path="settings/*" element={<SettingsPage />} />
        </Route>
        <Route
          path="editor/:projectId"
          element={
            <Suspense fallback={<Loading label="Loading the 3D editor" />}>
              <EditorPage />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SessionProvider>
  );
}

export function App({ config }: { config: AppConfig }) {
  return (
    <>
      <Show when="signed-out">
        <LandingPage config={config} />
      </Show>
      <Show when="signed-in">
        <SignedIn config={config} />
      </Show>
    </>
  );
}
