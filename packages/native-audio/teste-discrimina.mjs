/**
 * Teste que DISCRIMINA (o anterior nao discriminava).
 *
 * O tom toca no processo do Claude. Capturamos em modo INCLUDE dois PIDs:
 * o que toca e um que nao toca. Se os dois vierem com som, o modo INCLUDE nao
 * esta filtrando nada.
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const nativo = require('./index.js')

function rms(buffers) {
  let soma = 0, n = 0
  for (const b of buffers) for (let i = 0; i + 1 < b.length; i += 2) {
    const s = b.readInt16LE(i) / 32768; soma += s * s; n++
  }
  return n ? Number(Math.sqrt(soma / n).toFixed(5)) : 0
}

async function capturar(pid, include, ms = 2500) {
  const bufs = []
  try {
    nativo.startCapture(pid, include, (c) => bufs.push(c))
  } catch (e) {
    return { erro: String(e.message ?? e) }
  }
  await new Promise(r => setTimeout(r, ms))
  nativo.stopCapture()
  return { pacotes: bufs.length, rms: rms(bufs), erro: nativo.ultimoErro() }
}

const PID_QUE_TOCA = Number(process.argv[2])
const PID_SILENCIOSO = Number(process.argv[3])

console.log(`INCLUDE do processo que TOCA (${PID_QUE_TOCA}):`, await capturar(PID_QUE_TOCA, true))
console.log(`INCLUDE do processo SILENCIOSO (${PID_SILENCIOSO}):`, await capturar(PID_SILENCIOSO, true))
console.log(`EXCLUDE do processo que TOCA (${PID_QUE_TOCA}):`, await capturar(PID_QUE_TOCA, false))
