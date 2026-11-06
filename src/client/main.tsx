import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { appRoute } from './app/routes';
import { SharedComic } from './features/comic/SharedComic';
import './style.css';

const router = createBrowserRouter([
  { path: '/shared/:token', element: <SharedComic /> },
  appRoute,
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
