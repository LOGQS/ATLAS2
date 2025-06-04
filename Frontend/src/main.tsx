import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import App from './App.tsx'
import ReactPlayground from './ReactPlayground.tsx'
import './index.css'
import { StagewiseToolbar } from '@stagewise/toolbar-react';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />
  },
  {
    path: '/react-playground',
    element: <ReactPlayground />
  }
])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)

if (import.meta.env.DEV) {
  const stagewiseConfig = {
    plugins: []
  };
  const toolbarRootElement = document.createElement('div');
  toolbarRootElement.id = 'stagewise-toolbar-root';
  document.body.appendChild(toolbarRootElement);
  ReactDOM.createRoot(toolbarRootElement).render(
    <React.StrictMode>
      <StagewiseToolbar config={stagewiseConfig} />
    </React.StrictMode>
  );
}
