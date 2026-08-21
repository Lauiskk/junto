import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

/**
 * Sem StrictMode de proposito: em dev ele monta cada componente duas vezes, o que
 * abriria duas conexoes de signaling e duas negociacoes WebRTC para a mesma sala.
 * Para app de midia isso atrapalha mais do que ajuda.
 */
const container = document.getElementById('root')
if (!container) throw new Error('#root nao encontrado')

createRoot(container).render(<App />)
