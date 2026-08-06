import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Inter, self hosted through the npm package rather than fetched from Google
// Fonts. The portal has to work on a machine with no route to the internet and
// must not depend on a third party host being up, which is the same reason no
// other asset is loaded from a CDN. The variable build is one file for every
// weight, so it is smaller than the handful of static cuts it replaces.
import '@fontsource-variable/inter'

import App from './App.jsx'
import './styles/index.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
