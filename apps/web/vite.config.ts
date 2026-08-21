import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Aberto na rede local para testar de outro PC ou do celular sem tunel.
    host: true
  },
  preview: { port: 5173, host: true }
})
