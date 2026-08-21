import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// Sem StrictMode: a montagem dupla do dev criaria duas salas e duas sessoes.
const container = document.getElementById('root')
if (!container) throw new Error('#root nao encontrado')

createRoot(container).render(<App />)
