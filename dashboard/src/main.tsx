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
        <span className="brand">
          <span className="prompt">$</span>snapdoc admin<span className="cursor" />
        </span>
        <nav>
          <NavLink to="/" end className={navClass}>
            artifacts
          </NavLink>
          <NavLink to="/tokens" className={navClass}>
            tokens
          </NavLink>
        </nav>
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
