import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/ibm-plex-mono/latin-400.css';
import './style.css';
import { App } from './App';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
