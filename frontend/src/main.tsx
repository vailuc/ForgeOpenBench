import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Rehydrate skin before first paint — prevents flash of default skin
const savedSkin = localStorage.getItem("fob.skin");
if (savedSkin) document.documentElement.setAttribute("data-skin", savedSkin);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
