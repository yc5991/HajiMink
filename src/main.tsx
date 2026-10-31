import React from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './Auth';
import './style.css';
import './auth.css';
import './mobile.css';
import './workspace.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><Root/></React.StrictMode>);
