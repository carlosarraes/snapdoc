import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, NavLink, Outlet, RouterProvider } from "react-router-dom";
import "./theme.css";
import { Artifacts } from "./views/Artifacts";
import { ArtifactDetail } from "./views/ArtifactDetail";
import { Tokens } from "./views/Tokens";

function navClass({ isActive }: { isActive: boolean }) {
  return isActive ? "active" : "";
}

function Layout() {
  return (
    <>
      <header className="topbar">
        <div className="bar">
          <span className="brand">
            <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="6" fill="#0d1117" />
              <text x="7" y="23" fontFamily="monospace" fontSize="18" fontWeight="bold" fill="#3fb950">
                $_
              </text>
            </svg>
            <span className="wordmark">
              snapdoc<span className="cursor" />
            </span>
          </span>
          <nav>
            <NavLink to="/" end className={navClass}>
              artifacts
            </NavLink>
            <NavLink to="/tokens" className={navClass}>
              tokens
            </NavLink>
          </nav>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
}

const router = createHashRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Artifacts /> },
      { path: "a/:id", element: <ArtifactDetail /> },
      { path: "tokens", element: <Tokens /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
